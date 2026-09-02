/**
 * Immediate drain kick (recipe #3). After a producer enqueues a hot-queue job
 * (accept → events.ingested, approve → actions.approved, a parent's text →
 * channel.message.received), fire the drain right away inside Next's after() so the
 * common case doesn't wait up to 60s for the next cron tick. The every-minute drain
 * cron stays the safety-net reaper for anything this kick misses.
 *
 * Implemented as an internal authenticated GET to the SAME cron-secret-gated
 * /api/cron/drain route — no duplicate drain logic, no second pg-boss wiring.
 *
 * IT MUST BE AWAITED, and that is the whole reason this returns a promise.
 *
 * It used to be `void fetch(...)` inside a callback that returned nothing, so the
 * platform saw an after() callback that had already finished and was free to suspend the
 * instance — with the kick's request still sitting in a frozen event loop, going out
 * whenever that instance was next thawed. Measured in production on 2026-08-13: a text at
 * 14:00:50 whose kicked drain arrived at 14:01:09, and one at 13:47:47 whose kick arrived
 * at 13:47:59. Those 12-19 seconds were the whole of the "too slow" complaint, and they
 * were invisible because a swallowed kick logged nothing.
 *
 * WHAT AWAITING COSTS: the producing function stays alive until the drain answers, which
 * for the inbound slice is one coach turn. That is the honest price of the request
 * actually leaving the box, and it is bounded by {@link KICK_TIMEOUT_MS}.
 *
 * WHAT A TIMEOUT DOES NOT DO: it does not cancel the drain. The drain is a separate
 * invocation holding a pg-boss job; abandoning our end of the request abandons only the
 * summary we were going to log. The job either completes there or expires and re-drives,
 * and the turn ledger makes that re-drive silent (channel/router/turn-ledger.ts).
 */

/**
 * How long a kicker waits on the drain before letting go. Longer than a bounded coach
 * turn, far shorter than the drain's own 700s budget — a producer route is never held
 * for a full backlog.
 */
export const KICK_TIMEOUT_MS = 60_000;

/**
 * How many kicks this instance will have in flight at once.
 *
 * A kick asks for a drain of a SHARED queue, so N kicks in flight are N invocations
 * doing the same work over the same rows — and each one holds its own pg-boss connection
 * on the direct 5432 port plus the drain's pools, against a database with tens of usable
 * connections. One kick per inbound text with nothing bounding them is how a signup
 * burst becomes connection exhaustion, and exhaustion is how texts go unanswered.
 *
 * Shedding costs almost nothing: a drain already running loops until its queue comes
 * back empty, so a job committed before this kick was shed is picked up by one of them,
 * and the every-minute cron is the floor under whatever they miss.
 *
 * PER INSTANCE, and that is all module state can be. This bounds the fan-out of ONE
 * instance serving concurrent invocations; it cannot bound a hundred instances serving
 * one text each. The bound that does cross instances is {@link KICK_BACKOFF_MS} — every
 * instance told the database is out of connections stops kicking on its own.
 */
export const MAX_IN_FLIGHT_KICKS = 3;

/**
 * How long a drain that could not reach the database silences this instance's kicks.
 *
 * Long enough for the connections held by the invocations already in flight to be given
 * back, short enough that a recovered database is kicked again within one cron tick —
 * so the worst case a parent experiences is the ordinary "wait for the cron" path this
 * kick exists to skip, not a mute Hale.
 */
export const KICK_BACKOFF_MS = 10_000;

/** Kicks are shed until this moment. Module state: per instance, reset by a cold start. */
let backoffUntilMs = 0;
/** Kicks this instance currently has in flight (see {@link MAX_IN_FLIGHT_KICKS}). */
let inFlight = 0;

/** Why a kick did not happen. Rule #11: an absent effect is a named, logged outcome. */
type KickFailure =
  | 'no_cron_secret'
  | 'request_failed'
  | 'at_capacity'
  | 'backing_off'
  | `http_${number}`;

function reportSkipped(reason: KickFailure, detail?: unknown): void {
  console.error(
    { reason, detail: detail instanceof Error ? detail.message : detail },
    'kick-drain: drain was not kicked (cron will reap)',
  );
}

/** A retryable failure this attempt hit, or null when the kick landed. 4xx-class
 * outcomes are reported inside and returned as null: config errors do not heal on
 * retry, so retrying them would just double the noise. */
async function attemptKick(
  url: URL,
  secret: string,
): Promise<{ reason: KickFailure; detail?: unknown } | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
    });
    if (response.ok) return null;
    // THE ONE 5xx THAT MUST NOT BE RETRIED: the drain could not get a database
    // connection (route.ts answers 503 for exactly that, and the platform uses the same
    // status when it sheds an invocation). A retry is a second invocation asking for a
    // connection that is not there, so during a burst every kick becomes two and the
    // retry path amplifies the exhaustion it is reacting to. Back off instead, for this
    // whole instance — a kick is worthless while the drain behind it cannot start.
    if (response.status === 503) {
      backoffUntilMs = Date.now() + KICK_BACKOFF_MS;
      reportSkipped('http_503', { backoffMs: KICK_BACKOFF_MS });
      return null;
    }
    if (response.status >= 500) return { reason: `http_${response.status}` };
    reportSkipped(`http_${response.status}`);
    return null;
  } catch (err) {
    return { reason: 'request_failed', detail: err };
  }
}

/**
 * @param queues Restrict the kicked run to this slice of the drain plan (see
 * `INBOUND_TURN_QUEUES`); omitted kicks a full drain. A slice is what stops a parent's
 * text queueing behind the outbound and LLM queues that share the tick.
 *
 * ONE RETRY, and only for failures that can heal (network/timeout, 5xx). Measured in
 * production 2026-08-15 22:21: a cold-start kick aborted on its timeout and the parent's
 * text waited 81 seconds for the next inbound to kick for it. A second attempt is safe
 * by construction — the drain route is idempotent (pg-boss job locking; the turn ledger
 * dedupes replies) — so the retry converts "cron will reap" into a served turn.
 */
export async function kickDrain(origin: string, queues?: readonly string[]): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    reportSkipped('no_cron_secret');
    return;
  }

  if (Date.now() < backoffUntilMs) {
    reportSkipped('backing_off', { until: new Date(backoffUntilMs).toISOString() });
    return;
  }
  if (inFlight >= MAX_IN_FLIGHT_KICKS) {
    reportSkipped('at_capacity', { inFlight });
    return;
  }

  const url = new URL('/api/cron/drain', origin);
  if (queues) url.searchParams.set('queues', queues.join(','));

  inFlight += 1;
  try {
    const first = await attemptKick(url, secret);
    if (first === null) return;

    console.error(
      {
        reason: first.reason,
        retrying: true,
        detail: first.detail instanceof Error ? first.detail.message : first.detail,
      },
      'kick-drain: first attempt failed — retrying once',
    );
    const second = await attemptKick(url, secret);
    if (second !== null) {
      reportSkipped(second.reason, second.detail);
    }
  } finally {
    inFlight -= 1;
  }
}

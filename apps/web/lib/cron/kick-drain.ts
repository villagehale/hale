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

/** Why a kick did not happen. Rule #11: an absent effect is a named, logged outcome. */
type KickFailure = 'no_cron_secret' | 'request_failed' | `http_${number}`;

function reportSkipped(reason: KickFailure, detail?: unknown): void {
  console.error(
    { reason, detail: detail instanceof Error ? detail.message : detail },
    'kick-drain: drain was not kicked (cron will reap)',
  );
}

/**
 * @param queues Restrict the kicked run to this slice of the drain plan (see
 * `INBOUND_TURN_QUEUES`); omitted kicks a full drain. A slice is what stops a parent's
 * text queueing behind the outbound and LLM queues that share the tick.
 */
export async function kickDrain(origin: string, queues?: readonly string[]): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    reportSkipped('no_cron_secret');
    return;
  }

  const url = new URL('/api/cron/drain', origin);
  if (queues) url.searchParams.set('queues', queues.join(','));

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
    });
    if (!response.ok) {
      reportSkipped(`http_${response.status}`);
    }
  } catch (err) {
    reportSkipped('request_failed', err);
  }
}

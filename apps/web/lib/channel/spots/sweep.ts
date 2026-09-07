import { type Database, type WatchedSpotReleaseReason, schema } from '@hale/db';
import { and, eq, lt } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type AcceptedStatus, SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { type FetchPage, createFetchBody } from '~/lib/registration/verify-sweep';
import { type SpotReading, readSpot, transitionKind } from './availability';
import { renderSpotOpen } from './copy';
import { resettleSpotWatchPromise } from './promise';
import {
  type LiveWatchedSpot,
  MAX_SEND_ATTEMPTS,
  claimOpenTransition,
  claimSendAttempt,
  clearFailedAttempt,
  closeBeforeSend,
  findLedgerRowByDedupeKey,
  loadDueSpots,
  loadExpiredSpots,
  markNotifiedAndRelease,
  readLedgerStatus,
  recordPoll,
  releaseWatchedSpot,
  setNotifiedMessage,
} from './store';
import { sanitizeSpotUrl } from './url';

/**
 * VIL-337 · THE WATCHED-SPOTS SWEEP — every ten minutes, re-read the course pages
 * families asked about, and text the one household whose class just opened.
 *
 * THE PROPERTY THIS FILE EXISTS TO HOLD: a parent is told exactly once per opening,
 * about a page that says so RIGHT NOW, and is never quietly marked as told. Everything
 * below is that sentence taken apart:
 *
 *   ONCE — `claimOpenTransition` is a guarded UPDATE whose counter rides in the dedupe
 *     key, and `claimSendAttempt` is spent immediately before the transport call. Two
 *     ticks reading one open page produce one claim; a lost post-send write costs one
 *     possible duplicate and never a loop.
 *   RIGHT NOW — a held observation (a 2 a.m. opening waiting out quiet hours) is
 *     re-derived against THIS tick's bytes before anything is composed. A page that
 *     refilled overnight is `closedBeforeSend`, not a text about a seat that is gone.
 *   NEVER QUIETLY — a Twilio accept is not a delivery (twilio/status.ts maps
 *     undelivered → failed and the delivery sweep forces a terminal within a day), so
 *     the watch stays LIVE after the send and is released only by a sent/delivered
 *     receipt on its own ledger row. A failed receipt buys exactly one more attempt
 *     under a new key, then a NAMED release.
 *
 * EVERY NON-SEND IS A COUNTED, NAMED OUTCOME (rule #11). A tick that reads twelve pages
 * and sends nothing has twelve reasons in {@link WatchedSpotsSweepSummary}, not one
 * silence — because the failure mode this whole lane can have is looking healthy while
 * a parent is never told, and a number is the only thing that distinguishes those.
 *
 * IT NEVER THROWS FOR ONE SPOT. A municipality being down is that spot's `failed`
 * count; the run returns, the heartbeat stamps (cron/auth.ts stamps on COMPLETION), and
 * the founder is not paged for somebody else's flaky portal.
 *
 * NO MODEL RUNS ON THIS PATH — not the reader (availability.ts is a brace scan and a
 * Zod parse) and not the composer (copy.ts is a template with an evidence gate). The
 * cron route deliberately constructs no Anthropic client.
 */

/** The dark-launch gate for the sweep itself. STRICT on the literal 'true' for the
 * reason f14Enabled is (`vercel env add` from a piped echo stores a trailing newline):
 * a truthiness check would read `'true\n'` as ON and start polling municipalities
 * nobody armed. */
export const WATCHED_SPOTS_ENABLED_ENV = 'WATCHED_SPOTS_ENABLED';

export function watchedSpotsEnabled(): boolean {
  return process.env[WATCHED_SPOTS_ENABLED_ENV] === 'true';
}

/** The rate_limits `route` this sweep's per-slot claim lives under — an ops event with
 * no family, made exactly-once by the table's (identifier, route, window_start) index,
 * exactly like the weekly registration-verify claim. */
export const WATCHED_SPOTS_ROUTE = 'ops:watched-spots';

/** The cron's own period. The claim window IS the schedule, so a Vercel retry or a
 * manual re-trigger inside one slot cannot spend a second round of GETs on a public
 * body's server. */
export const SLOT_MS = 600_000;

/** Claims are housekeeping. A week is long enough to read a history off and short
 * enough that the table stays a handful of rows at six claims an hour. */
const CLAIM_RETENTION_DAYS = 7;

/**
 * The statuses a heal may attach a watch to — SENT_STATUSES, the ledger's own name for
 * "the send happened and nothing has come back to say it did not arrive".
 *
 * An ALLOWLIST because the complement is five statuses, not one: 'failed' plus the four
 * suppressions, every one of them a row that says in terms that this parent was not
 * texted. Spelling the guard as `!== 'failed'` would heal onto the other four, and onto
 * whatever the enum gains next — the trap re-opening itself on a schema edit nobody
 * connects to this file.
 */
const HEALABLE_STATUSES: ReadonlySet<string> = new Set(SENT_STATUSES);

/**
 * How many live watches one run may READ. Sized against the route's 300 s ceiling and
 * the worst case stated honestly: 20 distinct hosts × (15 s timeout + 2.5 s spacing) is
 * 350 s, so on a bad tick roughly thirteen spots reach the network and the rest rotate
 * to the next one. Today's registry has two hosts, so the real ceiling is eight GETs.
 */
export const MAX_SPOTS_PER_RUN = 20;

/**
 * How many watches one run may END on the expiry clock. Bounded like everything else
 * here, and generously: an expiry is three small writes and no request to anybody, so
 * fifty is well inside the route's ceiling while a season change across the product is
 * still drained in a handful of ticks. The overflow is not lost — see the expiry check
 * that opens {@link sweepSpot}.
 */
export const MAX_EXPIRED_SPOTS_PER_RUN = 50;

/** How many due rows are loaded before the F14 filter and the slice. Bounded in SQL
 * (`loadDueSpots` LIMITs on the partial due index) rather than by loading the product's
 * every watch to throw most of them away. */
export const MAX_DUE_SPOTS_SCANNED = 80;

/**
 * Requests to ONE municipality per run — six runs an hour, so at most 24 GETs an hour
 * per host however many families watch it. Counted on UNCACHED fetches only: N watches
 * on one page are one GET (see the per-run page cache), because re-reading the same
 * bytes four times leans four times as hard on a public body's server for nothing.
 */
export const MAX_FETCHES_PER_HOST_PER_RUN = 4;

/** Re-checked BEFORE each spot, inside the route's 300 s. A spot the budget does not
 * reach keeps its `next_poll_at` and is first in line next tick. */
export const WALL_BUDGET_MS = 240_000;

/** Inter-request spacing, jittered: 500–2,500 ms before every uncached fetch. `random`
 * and `sleep` are injected because `Math.random` appears nowhere in this app's
 * production source and a sweep nobody can make deterministic is a sweep nobody can
 * prove is spaced. */
export const FETCH_SPACING_MIN_MS = 500;
export const FETCH_SPACING_SPAN_MS = 2_000;

/** Unreadable reads before the watch ends loudly. Six is roughly ten hours of backoff —
 * long enough to ride out a portal outage, short enough that a vendor redesign becomes
 * a released watch and a Radar count rather than a row that reports nothing forever. */
export const MAX_CONSECUTIVE_FAILURES = 6;

/** Backoff after an unreadable read: `600_000 × 2^failures`, capped at six hours. It is
 * the ONLY thing that writes `next_poll_at` — a healthy read leaves the column alone, so
 * a tick that fires two minutes late still finds every live spot due instead of quietly
 * halving its own cadence. */
export const BACKOFF_BASE_MS = 600_000;
export const BACKOFF_CEILING_MS = 6 * 3_600_000;

/**
 * The idempotency key one attempt sends under.
 *
 * Two counters, both from the row: `openTransitions` makes one OPENING one text forever
 * (a class that fills and frees again mints a new key rather than being silenced), and
 * `attempt` is what lets a deliberate retry exist at all — `CONSUMED_SEND_STATUSES`
 * includes 'failed', and the ledger's own note says a deliberate retry mints its own key.
 */
export function spotOpenKey(spotId: string, openTransitions: number, attempt: number): string {
  return `spot_open:${spotId}:${openTransitions}:${attempt}`;
}

/**
 * Claim this ten-minute slot; true exactly once, for whoever gets there first.
 *
 * KEPT DELIBERATELY even though every other write here is its own claim: because a
 * healthy read no longer advances `next_poll_at`, this is the only thing standing
 * between a double cron fire and a second round of requests to a municipality.
 */
export async function claimWatchedSpotsSlot(database: Database, now: Date): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);

  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, WATCHED_SPOTS_ROUTE),
        lt(
          schema.rateLimits.windowStart,
          new Date(now.getTime() - CLAIM_RETENTION_DAYS * 86_400_000),
        ),
      ),
    );

  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: 'poll-slot', route: WATCHED_SPOTS_ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
    })
    .returning({ id: schema.rateLimits.id });

  return claimed.length > 0;
}

/** The outbound row one opening leaves behind — the {@link SequenceLedgerWrite} shape,
 * narrowed to this lane's single category. */
export interface SpotLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms';
  category: 'spot_open';
  templateKey: string;
  dedupeKey: string;
  status: AcceptedStatus;
  providerMessageId: string;
  sentAt: Date;
}

export interface SpotAuditRow {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

/**
 * Every effect this sweep can have, injected and NON-NULLABLE (rule #11).
 *
 * There is no "compose but do not send" shape here and no nullable transport: the three
 * P0s the registration ladder shipped with were all one — a message composed perfectly
 * and dropped on the floor because nothing was wired to send it. A caller that genuinely
 * wants no send belongs behind an explicit, result-visible flag.
 *
 * The store and promise writers are NOT injected. They take the same `database` handle
 * and their whole content is SQL — a guarded UPDATE, a partial index, four CHECKs — so a
 * fake of them can only ever return what a test handed it, and the tests that matter here
 * run against the real DDL on pglite instead.
 */
export interface WatchedSpotsSweepDeps {
  /** THE NETWORK, and the only one: the raw body, with the shared timeout, status throw,
   * 4 MB refusal and `redirect: 'error'` (verify-sweep.ts). Never the stripped page —
   * `stripHtml` deletes the `<script>` block a PerfectMind course page keeps its whole
   * availability record in, so a watcher built on it could never see a spot open. */
  fetchBody: FetchPage;
  claimSlot(database: Database, now: Date): Promise<boolean>;
  buildGate(database: Database): OutboundGatePorts;
  /** The send-boundary gate (VIL-293), on the string that actually leaves. REQUIRED: a
   * lane that could skip it would send exactly the claims it exists to stop. */
  refuseUnbackedSend: typeof refuseUnbackedSend;
  /** The ONE send-side reader (sms-consent-core), which carries the verified +
   * non-revoked predicate itself. */
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  recordSend(database: Database, write: SpotLedgerWrite): Promise<string>;
  audit(database: Database, row: SpotAuditRow): Promise<void>;
  /** The parent's own thread — `channel_messages` carries no body (rule #1), so a send
   * that skips this is a sentence the coach can never see the parent answering. */
  threadMessage: typeof threadProactiveMessage;
  random(): number;
  sleep(ms: number): Promise<void>;
  /** The wall clock the run's own budget is measured on, injected apart from `now`:
   * `now` is the logical instant every write is stamped with, this is elapsed time. */
  clockMs(): number;
}

export function defaultWatchedSpotsSweepDeps(): WatchedSpotsSweepDeps {
  return {
    fetchBody: createFetchBody(),
    claimSlot: claimWatchedSpotsSlot,
    buildGate: buildOutboundGatePorts,
    refuseUnbackedSend,
    resolveSendablePhone,
    transport: createTwilioTransport(),
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('runWatchedSpotsSweep: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    threadMessage: threadProactiveMessage,
    random: Math.random,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clockMs: () => Date.now(),
  };
}

/**
 * What became of ONE spot on this tick. Exhaustive by construction: the per-spot
 * function returns exactly one of these and {@link tally} is the only place a counter
 * moves, so "every non-send has a name" is read off one switch rather than trusted.
 */
type SpotFate =
  | { kind: 'skipped'; reason: 'wall_budget' | 'host_budget' }
  | { kind: 'released'; reason: WatchedSpotReleaseReason }
  | { kind: 'awaiting_receipt' }
  | { kind: 'healed' }
  | { kind: 'unreadable' }
  | { kind: 'quiet' }
  | { kind: 'raced' }
  | { kind: 'closed_before_send' }
  | { kind: 'held'; reason: ProactiveHoldReason }
  | { kind: 'refused' }
  | { kind: 'sent' }
  | { kind: 'failed' };

export interface WatchedSpotsSweepSummary {
  /** False when WATCHED_SPOTS_ENABLED did not arm the sweep. Nothing was loaded,
   * claimed or fetched — a named no-op rather than an empty one. */
  enabled: boolean;
  /** Spots that got a READING this run, from the network or from the page cache. Not a
   * fate: a polled spot also lands in exactly one of the counters below. */
  polled: number;
  /** Openings claimed this run — the guarded UPDATE returned a row. */
  transitions: number;
  sent: number;
  /** Read fine, nothing to say. The common outcome on most ticks. */
  quiet: number;
  /** The page could not be read AS A COURSE PAGE. Never a state: a page you could not
   * open is not a page that says the class is full. */
  unreadable: number;
  /** Another tick claimed the same opening first. Not an error. */
  raced: number;
  /** A text that went out on an earlier tick whose bookkeeping write was lost, found
   * again by its dedupe key and STILL LIVE — a row the carrier has already failed is a
   * retry, never a heal, or this number would count texts nobody received. */
  healed: number;
  /** A held observation the page contradicted before Hale was allowed to speak. */
  closedBeforeSend: number;
  /** A text out with no terminal receipt yet — still live, and not re-read this tick. */
  awaitingReceipt: number;
  /** The wire body claimed a row the family's ledger does not hold (VIL-293). Its own
   * count: nothing broke, and a non-zero here means the TEMPLATE is asserting something. */
  refused: number;
  failed: number;
  held: Record<ProactiveHoldReason, number>;
  released: Record<WatchedSpotReleaseReason, number>;
  skipped: {
    wallBudget: number;
    hostBudget: number;
    f14Dark: number;
    /** True when this slot was already swept — a double cron fire, total no-op, zero
     * requests to any municipality. */
    slotClaimed: boolean;
  };
}

function emptySummary(enabled: boolean): WatchedSpotsSweepSummary {
  return {
    enabled,
    polled: 0,
    transitions: 0,
    sent: 0,
    quiet: 0,
    unreadable: 0,
    raced: 0,
    healed: 0,
    closedBeforeSend: 0,
    awaitingReceipt: 0,
    refused: 0,
    failed: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    released: {
      notified: 0,
      expired: 0,
      parent_stopped: 0,
      consent_withdrawn: 0,
      unreadable_streak: 0,
      registration_closed: 0,
      delivery_failed: 0,
      send_unconfirmed: 0,
    },
    skipped: { wallBudget: 0, hostBudget: 0, f14Dark: 0, slotClaimed: false },
  };
}

function tally(summary: WatchedSpotsSweepSummary, fate: SpotFate): void {
  switch (fate.kind) {
    case 'skipped':
      if (fate.reason === 'wall_budget') summary.skipped.wallBudget += 1;
      else summary.skipped.hostBudget += 1;
      return;
    case 'released':
      summary.released[fate.reason] += 1;
      return;
    case 'held':
      summary.held[fate.reason] += 1;
      return;
    case 'awaiting_receipt':
      summary.awaitingReceipt += 1;
      return;
    case 'healed':
      summary.healed += 1;
      return;
    case 'unreadable':
      summary.unreadable += 1;
      return;
    case 'quiet':
      summary.quiet += 1;
      return;
    case 'raced':
      summary.raced += 1;
      return;
    case 'closed_before_send':
      summary.closedBeforeSend += 1;
      return;
    case 'refused':
      summary.refused += 1;
      return;
    case 'sent':
      summary.sent += 1;
      return;
    case 'failed':
      summary.failed += 1;
  }
}

/** Everything one run shares across its spots. */
interface RunContext {
  deps: WatchedSpotsSweepDeps;
  gate: OutboundGatePorts;
  now: Date;
  summary: WatchedSpotsSweepSummary;
  /** One GET per distinct url per run, failures included. */
  pages: Map<string, Promise<string>>;
  /** Uncached fetches spent per host this run. */
  hostSpend: Map<string, number>;
  /** The enrolment + consent answer per parent, asked once per run. */
  precheck: Map<string, Promise<PrecheckVerdict>>;
}

type PrecheckVerdict = 'ok' | 'parent_stopped' | 'consent_withdrawn';

/**
 * The last error text this module is allowed to keep. A portal's own error carries the
 * url it was fetched from, which is a page one family asked about — so the host is what
 * a log line may name, and the message is kept only for the failure counter's detail.
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runWatchedSpotsSweep(
  database: Database,
  deps: WatchedSpotsSweepDeps,
  now: Date = new Date(),
): Promise<WatchedSpotsSweepSummary> {
  const summary = emptySummary(watchedSpotsEnabled());

  // THE EXPIRY PASS IS NOT GATED ON EITHER FLAG, and it runs before the F14 filter: a
  // season that ran out ended whether or not this sweep is polling and whether or not
  // this household is armed. It spends no fetch — that is what makes it free to run in
  // the dark — and the rows it ends are the ones nobody would otherwise look at again,
  // holding a label and a course page past the sixty days the parent agreed to (rule #1).
  const expired = await loadExpiredSpots(database, now, MAX_EXPIRED_SPOTS_PER_RUN);
  const expiredIds = new Set(expired.map((spot) => spot.id));

  // The F14 filter sits BEFORE the slice so a dark household cannot consume an armed
  // one's place in the run. The watch is NOT released: re-arming the family resumes it,
  // and it expires on its own clock meanwhile.
  const armed: LiveWatchedSpot[] = [];
  if (summary.enabled) {
    for (const spot of await loadDueSpots(database, now, MAX_DUE_SPOTS_SCANNED)) {
      // Ended below, and counted there. Polling it would be a second release, a second
      // trail row and a second promise settlement for one ending.
      if (expiredIds.has(spot.id)) continue;
      if (!f14EnabledFor(spot.familyId)) {
        summary.skipped.f14Dark += 1;
        console.info({ spotId: spot.id }, 'watched spots: family is dark, spot not polled');
        continue;
      }
      armed.push(spot);
    }
  }

  const working = armed.slice(0, MAX_SPOTS_PER_RUN);
  // Nothing to do at all: no claim, so a quiet hour does not spend the slot a real tick
  // would have wanted, and the claim table stays a record of runs that had work.
  if (expired.length === 0 && working.length === 0) return summary;

  if (!(await deps.claimSlot(database, now))) {
    summary.skipped.slotClaimed = true;
    return summary;
  }

  // Under the slot claim like every other write: two fires inside one ten-minute slot
  // must not both settle the same promise and write the same ending to the trail twice.
  for (const spot of expired) {
    tally(summary, await releaseSpot(database, deps, now, spot, 'expired', null, {}));
  }
  if (working.length === 0) return summary;

  const context: RunContext = {
    deps,
    gate: deps.buildGate(database),
    now,
    summary,
    pages: new Map(),
    hostSpend: new Map(),
    precheck: new Map(),
  };

  const deadline = deps.clockMs() + WALL_BUDGET_MS;
  for (const spot of working) {
    if (deps.clockMs() >= deadline) {
      tally(summary, { kind: 'skipped', reason: 'wall_budget' });
      continue;
    }
    let fate: SpotFate;
    try {
      fate = await sweepSpot(database, spot, context);
    } catch (err) {
      // One municipality — or one contradiction inside one household — is that spot's
      // outcome, never the run's. The run must RETURN so the heartbeat stamps.
      console.error(
        { spotId: spot.id, detail: errorText(err) },
        'watched spots: the spot failed',
      );
      fate = { kind: 'failed' };
    }
    tally(summary, fate);
  }

  return summary;
}

async function sweepSpot(
  database: Database,
  spot: LiveWatchedSpot,
  context: RunContext,
): Promise<SpotFate> {
  const { deps, now, summary } = context;

  // The expiry pass at the top of the run has already ended every watch it had room for;
  // this is where the ones over that bound land. Still first, so an expired watch never
  // costs a municipality a request.
  if (spot.expiresAt.getTime() <= now.getTime()) {
    return releaseSpot(database, deps, now, spot, 'expired', null, {});
  }

  // BEFORE ANY FETCH. A household that pressed STOP or withdrew watch consent can never
  // be come back to, so it must not cost a municipality another GET — and learning it
  // from the gate AFTER the read would spend one every ten minutes for sixty days.
  const verdict = await prechecked(context, spot.parentUserId);
  if (verdict !== 'ok') {
    return releaseSpot(database, deps, now, spot, verdict, null, {});
  }

  // The stored url is what `sanitizeSpotUrl` REBUILT, so re-reading it is idempotent —
  // and it is where the courseId the reader matches on and the portal label the sentence
  // leads with both come from. A refusal here means the registry no longer carries this
  // host: loud and counted, never a release, because ending a parent's watch on a deploy
  // is not something a sweep gets to do quietly.
  const link = sanitizeSpotUrl(spot.sourceUrl);
  if (!link.ok) {
    console.error(
      { spotId: spot.id, reason: link.reason },
      'watched spots: a live watch no longer sanitizes - it cannot be read',
    );
    return { kind: 'failed' };
  }

  // NOT a mutable local. Every question below is about the pointer AS THIS TICK LOADED
  // IT — "was this spot already texted for?" — and a local that the failed branch nulls
  // would make the heal condition further down mean something else in the same function.
  const notifiedMessageId = spot.notifiedMessageId;
  if (notifiedMessageId !== null) {
    const status = await readLedgerStatus(database, notifiedMessageId);
    if (status === null) {
      console.error(
        { spotId: spot.id },
        'watched spots: the notified ledger row is gone - the watch cannot be settled',
      );
      return { kind: 'failed' };
    }
    if (status === 'sent' || status === 'delivered') {
      await markNotifiedAndRelease(database, { spotId: spot.id, now });
      await resettleSpotWatchPromise(database, {
        familyId: spot.familyId,
        keptBy: notifiedMessageId,
        cancelReason: 'spot_watch_ended',
        now,
      });
      await deps.audit(database, releaseAudit(spot, 'notified', link.host, {}));
      return { kind: 'released', reason: 'notified' };
    }
    if (status === 'failed') {
      if (spot.sendAttempts >= MAX_SEND_ATTEMPTS) {
        return releaseSpot(database, deps, now, spot, 'delivery_failed', link.host, {
          attempts: spot.sendAttempts,
        });
      }
      // The observation SURVIVES — the class is still open and the parent still has not
      // heard — so only the pointer to the dead message is cleared, and this tick goes on
      // to re-read the page before trying again.
      await clearFailedAttempt(database, { spotId: spot.id, now });
    } else {
      // 'queued' and every suppression: a terminal is still coming (the delivery sweep
      // forces one within a day). No fetch, no write, still live.
      return { kind: 'awaiting_receipt' };
    }
  }

  const fetched = await readBody(context, spot, link.url, link.host);
  if (fetched.status === 'host_budget') return { kind: 'skipped', reason: 'host_budget' };

  const reading: SpotReading =
    fetched.status === 'fetch_failed'
      ? { state: 'unreadable', reason: 'fetch_failed' }
      : readSpot(fetched.body, link.courseId);
  summary.polled += 1;

  if (reading.state === 'unreadable') {
    const failures = spot.consecutiveFailures + 1;
    await recordPoll(database, {
      spotId: spot.id,
      lastState: null,
      consecutiveFailures: failures,
      nextPollAt: new Date(
        now.getTime() + Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_CEILING_MS),
      ),
      now,
    });
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      return releaseSpot(database, deps, now, spot, 'unreadable_streak', link.host, {
        readingReason: reading.reason,
      });
    }
    console.warn(
      { spotId: spot.id, host: link.host, reason: reading.reason, failures },
      'watched spots: the page could not be read',
    );
    return { kind: 'unreadable' };
  }

  if (reading.state === 'not_registrable') {
    return releaseSpot(database, deps, now, spot, 'registration_closed', link.host, {
      readingReason: reading.reason,
    });
  }

  if (spot.pendingKind !== null) {
    await stampRead(database, spot.id, now);
    // A previous attempt spent its counter and left no pointer AT THE START OF THIS TICK.
    // Its row is looked up by the derived key, and only its STATUS says which of three
    // things happened:
    //
    //   a HEALABLE row (queued, or already sent/delivered) — the text WENT OUT and the
    //     post-send write was lost. Heal the pointer and let the receipt path judge it.
    //   a row in any other status — 'failed', or one of the four suppressions. Nobody
    //     was texted, so there is nothing to heal onto: retry under a new key, or say
    //     `delivery_failed`. Asking `dedupeActive` here instead would answer yes for a
    //     failed row (CONSUMED_SEND_STATUSES includes 'failed') and re-attach the watch
    //     to a dead message, which the receipt path then clears again — heal, clear,
    //     heal, all night, while the parent is never told.
    //   no row at all — the row write itself was lost. Spend the second attempt, or say
    //     `send_unconfirmed`: the texts, if they left, cannot be accounted for.
    //
    if (notifiedMessageId === null && spot.sendAttempts > 0) {
      const priorKey = spotOpenKey(spot.id, spot.openTransitions, spot.sendAttempts);
      const prior = await findLedgerRowByDedupeKey(database, priorKey);
      if (prior !== null && HEALABLE_STATUSES.has(prior.status)) {
        await setNotifiedMessage(database, {
          spotId: spot.id,
          channelMessageId: prior.id,
          now,
        });
        return { kind: 'healed' };
      }
      if (spot.sendAttempts >= MAX_SEND_ATTEMPTS) {
        return releaseSpot(
          database,
          deps,
          now,
          spot,
          prior === null ? 'send_unconfirmed' : 'delivery_failed',
          link.host,
          { attempts: spot.sendAttempts },
        );
      }
    }

    if (!supportsKind(spot.pendingKind, reading)) {
      // A reading that does not support the held observation is USUALLY the page taking
      // it back. It can also be the page going FURTHER: a waitlist that reopened at
      // 02:00 and is a real seat by 08:00 does not support `waitlist_reopened` either.
      // Closing that as `closed_before_send` would write this tick's state as
      // `last_state`, leave `open -> open` next tick, and count an opening that is
      // actually there under a bucket that means it went away (rule #11).
      const escalated = transitionKind(spot.lastState, reading);
      if (escalated === null) {
        // The only honest thing that can happen to a stale observation. A 2 a.m. opening
        // held through quiet hours and gone by 8 a.m. is not news.
        await closeBeforeSend(database, { spotId: spot.id, lastState: reading.state, now });
        return { kind: 'closed_before_send' };
      }
      // The held claim is dropped back to the state it was claimed FROM — the claim below
      // carries that state in its WHERE clause, and a crash between the two writes leaves
      // an ordinary un-held transition for the next tick to claim.
      await closeBeforeSend(database, { spotId: spot.id, lastState: spot.lastState, now });
      return claimAndSend(database, context, spot, link, reading, escalated);
    }
    return sendSpotOpen(database, context, spot, link, reading, spot.pendingKind);
  }

  const kind = transitionKind(spot.lastState, reading);
  if (kind === null) {
    await recordPoll(database, {
      spotId: spot.id,
      lastState: reading.state,
      consecutiveFailures: 0,
      nextPollAt: null,
      now,
    });
    return { kind: 'quiet' };
  }

  await stampRead(database, spot.id, now);
  return claimAndSend(database, context, spot, link, reading, kind);
}

/**
 * Claim the opening and compose from THIS tick's bytes — the one path from a transition
 * to a sentence, whether the transition was read off a quiet page or off an observation
 * the page has since overtaken.
 */
async function claimAndSend(
  database: Database,
  context: RunContext,
  spot: LiveWatchedSpot,
  link: Extract<ReturnType<typeof sanitizeSpotUrl>, { ok: true }>,
  reading: Extract<SpotReading, { state: 'open' | 'full' | 'waitlist_full' }>,
  kind: NonNullable<LiveWatchedSpot['pendingKind']>,
): Promise<SpotFate> {
  const { now, summary } = context;
  const openTransitions = await claimOpenTransition(database, {
    spotId: spot.id,
    from: spot.lastState,
    to: reading.state,
    kind,
    now,
  });
  if (openTransitions === null) return { kind: 'raced' };
  summary.transitions += 1;

  // A fresh claim resets the attempt counter, so the send path below sees attempt 1.
  return sendSpotOpen(
    database,
    context,
    { ...spot, openTransitions, sendAttempts: 0, notifiedMessageId: null },
    link,
    reading,
    kind,
  );
}

/**
 * A successful read is a REACH, whatever else this tick decides about it.
 *
 * `cron_heartbeats` says the sweep fired; `max(last_polled_at)` says a spot was actually
 * looked at, which is what the Radar reads as freshness — so the ticks that transition
 * and send must stamp it too, or the signal goes stale exactly when the sweep is doing
 * the thing it exists for. The failure streak ends here for the same reason.
 *
 * `last_state` is deliberately NOT written: the transition claim's WHERE clause carries
 * the state this tick BELIEVED, so moving it first would make every claim lose to itself.
 * The quiet path writes it in one call of its own instead.
 */
function stampRead(database: Database, spotId: string, now: Date): Promise<void> {
  return recordPoll(database, {
    spotId,
    lastState: null,
    consecutiveFailures: 0,
    nextPollAt: null,
    now,
  });
}

/**
 * Does THIS tick's reading still support the observation being held?
 *
 * Asked again immediately before every compose, which is what makes deferral and
 * truthfulness one mechanism rather than two: a held opening the page has taken back is
 * a `closed_before_send`, and there is no path from a stored reading to a sentence.
 */
function supportsKind(
  kind: NonNullable<LiveWatchedSpot['pendingKind']>,
  reading: Extract<SpotReading, { state: 'open' | 'full' | 'waitlist_full' }>,
): boolean {
  if (kind === 'seat_opened') return reading.state === 'open';
  return (
    reading.state === 'full' &&
    reading.model.IsWaitListAvailable &&
    reading.model.WaitListSpotsLeft > 0
  );
}

/**
 * THE SIX-STEP LEDGERED RITUAL, in the order registration/sequence/run.ts spends it,
 * with one thing moved: the attempt is claimed AFTER the send-boundary gate and
 * immediately BEFORE the transport call.
 *
 * Spending it there is what makes both bounds true at once. A hold or a refusal must not
 * cost an attempt — nothing has been sent, and the next tick will re-derive the same
 * opening against fresh bytes — while a lost write AFTER the transport call must cost
 * one, or a text that went out would be re-sent every ten minutes forever.
 *
 * THE WATCH IS NOT RELEASED HERE and the promise is not kept here: a Twilio accept is
 * 'queued', not a delivery.
 */
async function sendSpotOpen(
  database: Database,
  context: RunContext,
  spot: LiveWatchedSpot,
  link: Extract<ReturnType<typeof sanitizeSpotUrl>, { ok: true }>,
  reading: Extract<SpotReading, { state: 'open' | 'full' | 'waitlist_full' }>,
  kind: NonNullable<LiveWatchedSpot['pendingKind']>,
): Promise<SpotFate> {
  const { deps, gate, now } = context;

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: spot.familyId,
      parentUserId: spot.parentUserId,
      // The CLASS is read off the stored, parent-set column — never an `urgent` flag
      // this sweep decides for itself (outbound-gate.ts URGENCY_ALLOWED).
      kind: spot.instant ? 'spot_open_instant' : 'spot_open',
      now,
      urgent: spot.instant,
    },
    gate,
  );
  if (!verdict.allowed) {
    // Nothing is written. `pending_kind` was already stored by the claim, so the
    // observation survives the hold and the next tick re-reads the page before composing.
    return { kind: 'held', reason: verdict.reason };
  }

  const body = renderSpotOpen({
    kind,
    portalLabel: link.portalLabel,
    label: spot.label,
    url: link.url,
    model: reading.model,
    evidence: reading.evidence,
  });

  const to = await deps.resolveSendablePhone(database, spot.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`runWatchedSpotsSweep: no send target for ${spot.parentUserId}`);
  }

  const wireBody = withOptOut(body, verdict.optOut);
  const unbacked = await deps.refuseUnbackedSend(database, {
    familyId: spot.familyId,
    body: wireBody,
    now,
  });
  if (unbacked.length > 0) {
    console.error(
      { spotId: spot.id, kind, reasons: unbacked },
      'watched spots: the wire body claims a row that does not exist - send refused',
    );
    return { kind: 'refused' };
  }

  const attempt = await claimSendAttempt(database, { spotId: spot.id, now });
  if (attempt === null) {
    // Both attempts are gone and no ledger row was ever found under either key: the
    // texts, if they left at all, cannot be accounted for. Ending the watch is the only
    // honest thing left — the delivery sweep's own vocabulary for it.
    return releaseSpot(database, deps, now, spot, 'send_unconfirmed', link.host, {
      attempts: spot.sendAttempts,
    });
  }

  const dedupeKey = spotOpenKey(spot.id, spot.openTransitions, attempt);
  const { providerMessageId } = await deps.transport.send({ to, body: wireBody });
  const messageId = await deps.recordSend(database, {
    familyId: spot.familyId,
    parentUserId: spot.parentUserId,
    channel: 'sms',
    category: 'spot_open',
    templateKey: `spot_open:${kind}`,
    dedupeKey,
    status: acceptedStatus('sms'),
    providerMessageId,
    sentAt: now,
  });
  await setNotifiedMessage(database, { spotId: spot.id, channelMessageId: messageId, now });
  await deps.audit(database, {
    familyId: spot.familyId,
    actor: 'system',
    actionTaken: 'watched_spot_opened_sent',
    targetTable: 'channel_messages',
    targetId: messageId,
    // Provenance only, never the page, the label or the body (rule #1).
    after: {
      watchedSpotId: spot.id,
      host: link.host,
      kind,
      openTransitions: spot.openTransitions,
      attempt,
      instant: spot.instant,
    },
  });
  // The COMPOSED sentence, never the wire body: the CASL line belongs on the wire and
  // nowhere else, and this row is what the coach re-reads when the parent answers.
  await deps.threadMessage(database, {
    familyId: spot.familyId,
    parentUserId: spot.parentUserId,
    body,
  });
  return { kind: 'sent' };
}

function releaseAudit(
  spot: LiveWatchedSpot,
  reason: WatchedSpotReleaseReason,
  host: string | null,
  extra: Record<string, unknown>,
): SpotAuditRow {
  return {
    familyId: spot.familyId,
    actor: 'system',
    actionTaken: 'watched_spot_released',
    targetTable: 'watched_spots',
    targetId: spot.id,
    after: { reason, ...(host === null ? {} : { host }), ...extra },
  };
}

/**
 * Stop watching, settle the promise, and say so on the trail — the three writes that
 * make an ending an ending.
 *
 * The promise is resettled on EVERY release, kept or not: `agent_commitments` permits one
 * open `spot_watch` per family, and a debt left due at the expiry of a watch that has
 * ended reads overdue in the founder digest while the household is still being watched,
 * on time (promise.ts re-records against the soonest remaining watch).
 */
async function releaseSpot(
  database: Database,
  deps: WatchedSpotsSweepDeps,
  now: Date,
  spot: LiveWatchedSpot,
  reason: Exclude<WatchedSpotReleaseReason, 'notified'>,
  host: string | null,
  extra: Record<string, unknown>,
): Promise<SpotFate> {
  await releaseWatchedSpot(database, { spotId: spot.id, reason, now });
  await resettleSpotWatchPromise(database, {
    familyId: spot.familyId,
    keptBy: null,
    // 'channel_revoked' is about the LEAVING, not the watch; every other unkept ending
    // is the watch itself running out of ways to keep its promise.
    cancelReason:
      reason === 'parent_stopped' || reason === 'consent_withdrawn'
        ? 'channel_revoked'
        : 'spot_watch_ended',
    now,
  });
  await deps.audit(database, releaseAudit(spot, reason, host, extra));
  return { kind: 'released', reason };
}

/** Enrolment and watch consent for one parent, asked once per run through the same
 * ports the gate uses — a household with four watches is one pair of reads. */
function prechecked(context: RunContext, parentUserId: string): Promise<PrecheckVerdict> {
  const asked = context.precheck.get(parentUserId);
  if (asked) return asked;
  const pending = (async (): Promise<PrecheckVerdict> => {
    if (!(await context.gate.channelEnrolled(parentUserId))) return 'parent_stopped';
    if (!(await context.gate.watchConsentGranted(parentUserId))) return 'consent_withdrawn';
    return 'ok';
  })();
  context.precheck.set(parentUserId, pending);
  return pending;
}

/**
 * The bytes for one url — the page cache, the per-host budget and the jittered spacing,
 * in the one place a request can be made.
 *
 * A fetch failure is a NAMED outcome rather than a thrown error, because it is an
 * ordinary state of somebody else's website and the reading it produces (`unreadable`)
 * is the safety property: a page you could not open never becomes a state.
 */
async function readBody(
  context: RunContext,
  spot: LiveWatchedSpot,
  url: string,
  host: string,
): Promise<
  { status: 'ok'; body: string } | { status: 'host_budget' } | { status: 'fetch_failed' }
> {
  const { deps } = context;
  let pending = context.pages.get(url);
  if (!pending) {
    const spent = context.hostSpend.get(host) ?? 0;
    if (spent >= MAX_FETCHES_PER_HOST_PER_RUN) return { status: 'host_budget' };
    // Counted BEFORE the request, so a host that times out four times has still had its
    // four requests — the budget is politeness, not success accounting.
    context.hostSpend.set(host, spent + 1);
    await deps.sleep(FETCH_SPACING_MIN_MS + deps.random() * FETCH_SPACING_SPAN_MS);
    pending = deps.fetchBody(url);
    context.pages.set(url, pending);
  }
  try {
    return { status: 'ok', body: await pending };
  } catch (err) {
    // The fetch primitive names the url it failed on, and that url is one family's
    // course page — beside a spot id it is a household and a class in a log line
    // (rule #1). The host is what may be named, so the page is replaced by it and the
    // status the municipality answered survives.
    console.warn(
      { spotId: spot.id, host, detail: errorText(err).replaceAll(url, host) },
      'watched spots: the page could not be fetched',
    );
    return { status: 'fetch_failed' };
  }
}

import {
  type Database,
  type WatchedSpotPendingKind,
  type WatchedSpotReleaseReason,
  type WatchedSpotState,
  schema,
} from '@hale/db';
import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { recordSpotWatchPromise } from './promise';

/**
 * VIL-337 · THE WATCHED-SPOTS STORE — the whole write surface for a watch, in eight
 * queries.
 *
 * NARROW ON PURPOSE, on the `markWindowVerified` discipline: the sweep runs unattended
 * every ten minutes against pages it does not control, and the property that has to stay
 * checkable is that it cannot change a label, a URL or a household. Every writer here
 * touches the lifecycle columns and nothing else, so "the sweep cannot rewrite what the
 * parent asked for" is read off eight function bodies rather than trusted.
 *
 * THREE OF THEM ARE CLAIMS, not updates. The arm is an INSERT that conflicts (the partial
 * unique index arbitrates a parent who asks twice); the transition is a guarded UPDATE
 * whose WHERE clause carries the state it believed (a second tick loses); the send attempt
 * is a guarded increment that is spent BEFORE the transport call (a lost post-send write
 * costs one retry, never an unbounded loop). A select-then-write guard is a guard both
 * racers walk through.
 *
 * WHAT LIVE MEANS, everywhere: `released_at IS NULL`. Every write here says so, so a
 * released watch cannot be polled, claimed, sent for, or released twice.
 */

/**
 * What a driver error is allowed to say in a log line here.
 *
 * The raw error is NOT loggable in this module: postgres.js and pglite both hang the
 * failing statement and its parameters on it, and a constraint violation's `detail` is
 * "Failing row contains (…)" — every column, so the label the parent typed and the page
 * they pasted (rule #1). What identifies the fault is its code, the constraint it broke
 * and the primary message, none of which carry the row. `constraint` is pglite's spelling
 * and `constraint_name` is postgres.js's; both drivers run this module.
 */
function faultOf(err: unknown): {
  code: string | null;
  constraint: string | null;
  message: string;
} {
  const fields = err as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  const constraint = fields.constraint ?? fields.constraint_name;
  return {
    code: typeof fields.code === 'string' ? fields.code : null,
    constraint: typeof constraint === 'string' ? constraint : null,
    message: err instanceof Error ? err.message : String(err),
  };
}

/** How long a watch stands before it is released as `expired`. A season, not a year: past
 * this the class the parent asked about is a different class. */
export const WATCH_TTL_DAYS = 60;

/** Two attempts per opening — the send claim and the retry bound are the same counter.
 * The second exists because a Twilio accept is not a delivery: a `failed` receipt on the
 * first buys exactly one more text, and then the watch ends with a named reason rather
 * than trying forever. */
export const MAX_SEND_ATTEMPTS = 2;

/**
 * What the coach turn decided, on its way to the row.
 *
 * Everything here has already been through a gate: `url` is what `sanitizeSpotUrl`
 * REBUILT (https, a registry host, the one course-page path, two GUID parameters), `label`
 * is what the activity lane's de-identifying gate let through UNCHANGED, and `lastState`
 * is what a live read of that page said in the same turn the parent asked. Nothing raw
 * that a parent typed reaches this shape.
 */
export interface SpotWatchIntent {
  url: string;
  /** The registry host. What the audit rows and the logs are allowed to name — never the
   * page, never the label (rule #1). */
  host: string;
  /** How Hale says the portal out loud, for the copy that goes back to the parent. */
  portalLabel: string;
  label: string;
  instant: boolean;
  lastState: WatchedSpotState;
}

/**
 * What became of an arm. `already_watching` is deliberately NOT folded into either
 * neighbour (rule #11): it is neither a fresh watch nor a failure, and a caller that
 * cannot tell them apart cannot tell a parent asking twice from a lost write.
 */
export type WatchedSpotArmOutcome =
  | { status: 'armed'; spotId: string }
  | { status: 'already_watching' }
  | { status: 'not_armed'; reason: 'no_ledger_row' | 'write_failed' };

/** What a delivery receipt can have made of an attempt. */
export type LedgerStatus = (typeof schema.channelMessages.$inferSelect)['status'];

/** One live watch, as the sweep reads it. */
export interface LiveWatchedSpot {
  id: string;
  familyId: string;
  parentUserId: string;
  sourceUrl: string;
  label: string;
  instant: boolean;
  lastState: WatchedSpotState;
  pendingKind: WatchedSpotPendingKind | null;
  pendingSince: Date | null;
  consecutiveFailures: number;
  openTransitions: number;
  sendAttempts: number;
  notifiedMessageId: string | null;
  expiresAt: Date;
}

const LIVE_SPOT_COLUMNS = {
  id: schema.watchedSpots.id,
  familyId: schema.watchedSpots.familyId,
  parentUserId: schema.watchedSpots.parentUserId,
  sourceUrl: schema.watchedSpots.sourceUrl,
  label: schema.watchedSpots.label,
  instant: schema.watchedSpots.instant,
  lastState: schema.watchedSpots.lastState,
  pendingKind: schema.watchedSpots.pendingKind,
  pendingSince: schema.watchedSpots.pendingSince,
  consecutiveFailures: schema.watchedSpots.consecutiveFailures,
  openTransitions: schema.watchedSpots.openTransitions,
  sendAttempts: schema.watchedSpots.sendAttempts,
  notifiedMessageId: schema.watchedSpots.notifiedMessageId,
  expiresAt: schema.watchedSpots.expiresAt,
};

/**
 * Arm a watch — THE INSERT IS THE CLAIM.
 *
 * `watched_spots_live_uniq` is unique on (family, page) where the watch is live, so a
 * parent who asks twice, or a router that runs twice on one turn, conflicts in the
 * database instead of minting a second watch that would text one phone twice about one
 * seat. It is partial, so the same page can be watched again next season.
 *
 * SEND-TIME ONLY, like every writer on the open-loops ledger: armed against the outbound
 * row that carried the arming sentence, so a compose that never reached a transport
 * cannot leave a household being watched without being told.
 *
 * NEVER THROWS. It runs after the parent already has the text, where an exception buys a
 * carrier retry and a duplicate send — so a failure is an audit row (rule #11): "told but
 * not watching" is a number on the Radar rather than a line in a log nobody reads.
 */
export async function armWatchedSpot(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    intent: SpotWatchIntent;
    /** The outbound row that carried the arming sentence. Null means it never reached a
     * transport. */
    channelMessageId: string | null;
    now: Date;
  },
): Promise<WatchedSpotArmOutcome> {
  if (input.channelMessageId === null) {
    return armFailed(database, input, 'no_ledger_row');
  }
  let claimed: { id: string; expiresAt: Date } | undefined;
  try {
    [claimed] = await database
      .insert(schema.watchedSpots)
      .values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        sourceUrl: input.intent.url,
        label: input.intent.label,
        instant: input.intent.instant,
        lastState: input.intent.lastState,
        expiresAt: new Date(input.now.getTime() + WATCH_TTL_DAYS * 86_400_000),
        createdFrom: input.channelMessageId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [schema.watchedSpots.familyId, schema.watchedSpots.sourceUrl],
        where: sql`${schema.watchedSpots.releasedAt} IS NULL`,
      })
      .returning({ id: schema.watchedSpots.id, expiresAt: schema.watchedSpots.expiresAt });
  } catch (err) {
    console.error(
      { fault: faultOf(err), familyId: input.familyId, host: input.intent.host },
      'watched spots: the arm failed after the parent was told - nothing is being watched',
    );
    return armFailed(database, input, 'write_failed');
  }
  if (!claimed) return { status: 'already_watching' };

  // THE WATCH EXISTS FROM HERE ON, and nothing below can unmake it: the row will be
  // polled and it can text. So the try above stops at the claim — a bookkeeping failure
  // reported as `not_armed` would put a phone that is about to be texted into the Radar's
  // failed-arm count, which is the number rule #11 exists to keep honest. The books are
  // loud instead.
  try {
    // `already_open` from the ledger is expected on the second and later watches: one
    // household is owed ONE "I'm watching" promise however many pages it is watching.
    await recordSpotWatchPromise(database, {
      familyId: input.familyId,
      channelMessageId: input.channelMessageId,
      expiresAt: claimed.expiresAt,
    });
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'watched_spot_armed',
      targetTable: 'watched_spots',
      targetId: claimed.id,
      // Provenance, never content: the host says which portal, `instant` is the parent's
      // own quiet-hours opt-in and this row is its receipt. The label and the page stay in
      // the table (rule #1).
      after: { watchedSpotId: claimed.id, host: input.intent.host, instant: input.intent.instant },
    });
  } catch (err) {
    console.error(
      {
        fault: faultOf(err),
        familyId: input.familyId,
        host: input.intent.host,
        spotId: claimed.id,
      },
      'watched spots: the watch is armed but its promise and its trail are not - this one is being watched off the books',
    );
  }
  return { status: 'armed', spotId: claimed.id };
}

/** The failed arm, on the trail. The audit write is itself best-effort: it runs on a path
 * that has already lost one write, and throwing here would turn a countable failure into a
 * carrier retry. */
async function armFailed(
  database: Database,
  input: { familyId: string; intent: SpotWatchIntent },
  reason: 'no_ledger_row' | 'write_failed',
): Promise<WatchedSpotArmOutcome> {
  try {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'watched_spot_arm_failed',
      targetTable: 'watched_spots',
      after: { reason, host: input.intent.host },
    });
  } catch (err) {
    console.error(
      { fault: faultOf(err), familyId: input.familyId, reason },
      'watched spots: the failed arm could not be recorded either - this one is invisible',
    );
  }
  return { status: 'not_armed', reason };
}

/**
 * The spots due a read, oldest wait first — the sweep's working set, bounded IN SQL.
 *
 * The bound is a LIMIT rather than a slice because the alternative is loading every watch
 * in the product to throw most of them away, and because `watched_spots_due_idx` is
 * partial on the same predicate: in a healthy system this touches only the spots still
 * being watched.
 */
export async function loadDueSpots(
  database: Database,
  now: Date,
  limit: number,
): Promise<LiveWatchedSpot[]> {
  return database
    .select(LIVE_SPOT_COLUMNS)
    .from(schema.watchedSpots)
    .where(
      and(
        isNull(schema.watchedSpots.releasedAt),
        lte(schema.watchedSpots.nextPollAt, now),
      ),
    )
    .orderBy(asc(schema.watchedSpots.nextPollAt), asc(schema.watchedSpots.createdAt))
    .limit(limit);
}

/**
 * What a read cost and what it found.
 *
 * `lastState` is null when the page could not be READ — an unreadable page is counted in
 * `consecutiveFailures` and changes nothing else, because a page you could not open is not
 * a page that says the class is full. `nextPollAt` is null on a healthy read: that column
 * carries BACKOFF only, so a tick that fires two minutes late still finds every live spot
 * due instead of quietly halving its own cadence.
 */
export async function recordPoll(
  database: Database,
  input: {
    spotId: string;
    lastState: WatchedSpotState | null;
    consecutiveFailures: number;
    nextPollAt: Date | null;
    now: Date;
  },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({
      ...(input.lastState === null ? {} : { lastState: input.lastState }),
      ...(input.nextPollAt === null ? {} : { nextPollAt: input.nextPollAt }),
      consecutiveFailures: input.consecutiveFailures,
      lastPolledAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/**
 * Claim the right to say that this class opened — the guarded UPDATE.
 *
 * The WHERE clause carries the state the caller BELIEVED (`from`, and no observation
 * already held). Two ticks reading the same open page therefore produce one claim: the
 * loser gets null, which is a race it lost rather than an error. The returned counter is
 * the idempotency anchor — it rides in the send's dedupe key, so one opening is one text
 * forever, while a class that fills and frees again mints a new key rather than a
 * silenced duplicate.
 *
 * `sendAttempts` resets here and `notifiedMessageId` clears here for the same reason: the
 * two attempts are per OPENING, not per watch.
 */
export async function claimOpenTransition(
  database: Database,
  input: {
    spotId: string;
    from: WatchedSpotState;
    to: WatchedSpotState;
    kind: WatchedSpotPendingKind;
    now: Date;
  },
): Promise<number | null> {
  const [row] = await database
    .update(schema.watchedSpots)
    .set({
      lastState: input.to,
      pendingKind: input.kind,
      pendingSince: input.now,
      openTransitions: sql`${schema.watchedSpots.openTransitions} + 1`,
      sendAttempts: 0,
      notifiedMessageId: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.watchedSpots.id, input.spotId),
        isNull(schema.watchedSpots.releasedAt),
        isNull(schema.watchedSpots.pendingKind),
        eq(schema.watchedSpots.lastState, input.from),
      ),
    )
    .returning({ openTransitions: schema.watchedSpots.openTransitions });
  return row?.openTransitions ?? null;
}

/**
 * Spend one send attempt, BEFORE the transport call.
 *
 * Spending it first is what makes a lost post-send write cost one possible duplicate
 * rather than an unbounded loop: the counter moved whether or not the ledger row landed.
 * Null means the two attempts are gone, or the observation this attempt was for has since
 * been dropped or already sent — each of which is a reason not to text, and none of which
 * is an error.
 */
export async function claimSendAttempt(
  database: Database,
  input: { spotId: string; now: Date },
): Promise<number | null> {
  const [row] = await database
    .update(schema.watchedSpots)
    .set({ sendAttempts: sql`${schema.watchedSpots.sendAttempts} + 1`, updatedAt: input.now })
    .where(
      and(
        eq(schema.watchedSpots.id, input.spotId),
        isNull(schema.watchedSpots.releasedAt),
        isNotNull(schema.watchedSpots.pendingKind),
        isNull(schema.watchedSpots.notifiedMessageId),
        sql`${schema.watchedSpots.sendAttempts} < ${MAX_SEND_ATTEMPTS}`,
      ),
    )
    .returning({ sendAttempts: schema.watchedSpots.sendAttempts });
  return row?.sendAttempts ?? null;
}

/** The text left, and this is the row that will say whether it arrived. Written straight
 * after the send; the watch stays LIVE until that row's receipt reads sent or delivered. */
export async function setNotifiedMessage(
  database: Database,
  input: { spotId: string; channelMessageId: string; now: Date },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({ notifiedMessageId: input.channelMessageId, updatedAt: input.now })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/** The receipt came back failed and an attempt is left. The held observation SURVIVES —
 * the class is still open and the parent still has not heard — so only the pointer to the
 * dead message is cleared, and the next tick re-reads the page before trying again. */
export async function clearFailedAttempt(
  database: Database,
  input: { spotId: string; now: Date },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({ notifiedMessageId: null, updatedAt: input.now })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/**
 * The page changed its mind before Hale was allowed to speak — the held observation is
 * dropped and the reading that overtook it becomes the state.
 *
 * The only honest thing that can happen to a stale observation. A 2 a.m. opening held
 * through quiet hours and gone by 8 a.m. is not news; sending it anyway would be Hale
 * telling a parent about a seat that closed six hours ago.
 */
export async function closeBeforeSend(
  database: Database,
  input: { spotId: string; lastState: WatchedSpotState; now: Date },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({
      pendingKind: null,
      pendingSince: null,
      lastState: input.lastState,
      updatedAt: input.now,
    })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/**
 * The text was CONFIRMED delivered: the watch is kept and it is over.
 *
 * `notifiedTransitions` is set to `openTransitions` rather than incremented so the two
 * counters cannot drift, and the CHECK that forbids notified > open is then unbreakable
 * by this writer.
 */
export async function markNotifiedAndRelease(
  database: Database,
  input: { spotId: string; now: Date },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({
      notifiedTransitions: sql`${schema.watchedSpots.openTransitions}`,
      pendingKind: null,
      pendingSince: null,
      releasedAt: input.now,
      releasedReason: 'notified',
      updatedAt: input.now,
    })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/**
 * Stop watching, with the reason on the row.
 *
 * A held observation is left exactly as it was: if Hale saw a seat open and the household
 * left before it could say so, that is the truth of what happened and deleting it would
 * make the ending read as an ordinary expiry.
 */
export async function releaseWatchedSpot(
  database: Database,
  input: { spotId: string; reason: WatchedSpotReleaseReason; now: Date },
): Promise<void> {
  await database
    .update(schema.watchedSpots)
    .set({ releasedAt: input.now, releasedReason: input.reason, updatedAt: input.now })
    .where(and(eq(schema.watchedSpots.id, input.spotId), isNull(schema.watchedSpots.releasedAt)));
}

/**
 * The ledger row an attempt left behind, found by the key it was sent under — WITH the
 * status the carrier has since written on it.
 *
 * The healing read: an attempt whose counter moved but whose `notified_message_id` never
 * landed is a text that WENT OUT and a watch that does not know it. The dedupe key is
 * derived, so the row can always be found again — which is the difference between one
 * duplicate and a watch that re-sends every ten minutes.
 *
 * The status is not decoration. `dedupeActive` answers true for a 'failed' row on
 * purpose (CONSUMED_SEND_STATUSES), so "the key is spent" and "a text may still arrive"
 * are different questions, and a heal that asks the first one re-attaches the watch to a
 * message the carrier threw away. Only this reader can tell them apart.
 */
export async function findLedgerRowByDedupeKey(
  database: Database,
  dedupeKey: string,
): Promise<{ id: string; status: LedgerStatus } | null> {
  const [row] = await database
    .select({ id: schema.channelMessages.id, status: schema.channelMessages.status })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey))
    .limit(1);
  return row ?? null;
}

/**
 * What the carrier finally said about one attempt.
 *
 * The whole delivery-truth path rests on this rather than on the transport's own answer: a
 * Twilio accept is 'queued', an undelivered receipt rewrites the same row to 'failed', and
 * the delivery sweep forces a terminal within a day. So the watch is released on the ROW,
 * never on the accept.
 */
export async function readLedgerStatus(
  database: Database,
  channelMessageId: string,
): Promise<LedgerStatus | null> {
  const [row] = await database
    .select({ status: schema.channelMessages.status })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, channelMessageId))
    .limit(1);
  return row?.status ?? null;
}

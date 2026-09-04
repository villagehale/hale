import type { Database } from '@hale/db';
import {
  type CommitmentCancelReason,
  type CommitmentRecordOutcome,
  cancelCommitment,
  fulfillCommitment,
  recordCommitment,
} from '~/lib/commitments/ledger';
import { soonestLiveWatch } from './store';

/**
 * VIL-337 · "I'M WATCHING THAT CLASS" IS A ROW — the spot watch on the MEM-10 open-loops
 * ledger, and the one place that keeps the promise and the watches in step.
 *
 * ONE PROMISE, HOWEVER MANY WATCHES. `agent_commitments` permits exactly one open promise
 * of a kind per family, and that is also the honest reading of what the parent was told:
 * Hale is watching. So the second and third arms come back `already_open`, which is
 * expected here rather than a failure — the debt is "Hale is watching for you", not "Hale
 * is watching this page".
 *
 * WHY A RELEASE HAS TO RE-RECORD. Overdue is a QUERY on `due_at`, so a promise left due
 * at the FIRST watch's expiry reads overdue in the founder digest for as long as a second
 * watch outlives it — Hale filed as having held a watch past its own expiry when it is
 * still watching, on time. Closing and re-recording against the soonest remaining watch
 * is what keeps that query true.
 *
 * Every ledger write here reports rather than throws, on the ledger's own reasoning: a
 * caller runs after a parent already has a text, where an exception buys a carrier retry
 * and a duplicate send (rule #11). What it cannot do is stay quiet — a promise that could
 * not be closed, or a re-record that found the old row still open, is logged with the
 * cost stated.
 */

/** The promise in one short, parent-safe sentence (rule #1): no label, no page, no class
 * — the household is watching something, and that is all the ledger needs to say. */
const SPOT_WATCH_SUMMARY = 'Hale is watching a full class and will text when a spot opens.';

/**
 * Open the promise, against the message that carried the arming sentence.
 *
 * Due when the watch expires: past that instant "I'll text you when a spot opens" is no
 * longer something that can happen, so the promise is late.
 */
export async function recordSpotWatchPromise(
  database: Database,
  input: {
    familyId: string;
    /** The outbound row that carried the sentence. Null means it never reached a
     * transport, and a promise nobody received is not a promise. */
    channelMessageId: string | null;
    expiresAt: Date;
  },
): Promise<CommitmentRecordOutcome> {
  return recordCommitment(database, {
    familyId: input.familyId,
    kind: 'spot_watch',
    summary: SPOT_WATCH_SUMMARY,
    dueAt: input.expiresAt,
    channelMessageId: input.channelMessageId,
  });
}

/**
 * Settle the promise against the watches that are actually left — called on EVERY release.
 *
 * `keptBy` is the `channel_messages` id of the spot-opened text whose delivery receipt
 * landed, and nothing else keeps this promise: a watch that expired, went unreadable or
 * lost its household did not deliver what it said it would.
 */
export async function resettleSpotWatchPromise(
  database: Database,
  input: {
    familyId: string;
    /** The message that KEPT it, or null when the watch ended without one. */
    keptBy: string | null;
    /** Why it ended unkept — read only when `keptBy` is null. 'channel_revoked' for a
     * household that left; 'spot_watch_ended' for every other unkept ending. */
    cancelReason: CommitmentCancelReason;
    now: Date;
  },
): Promise<void> {
  const closed =
    input.keptBy === null
      ? await cancelCommitment(database, {
          familyId: input.familyId,
          kind: 'spot_watch',
          reason: input.cancelReason,
          now: input.now,
        })
      : await fulfillCommitment(database, {
          familyId: input.familyId,
          kind: 'spot_watch',
          channelMessageId: input.keptBy,
          now: input.now,
        });
  if (closed.status === 'not_closed') {
    console.error(
      { familyId: input.familyId, reason: closed.reason },
      'spot watch: the promise could not be closed - it will read as still owed',
    );
    return;
  }

  const remaining = await soonestLiveWatch(database, input.familyId);
  if (!remaining) return;
  const rerecorded = await recordSpotWatchPromise(database, {
    familyId: input.familyId,
    channelMessageId: remaining.createdFrom,
    expiresAt: remaining.expiresAt,
  });
  // `already_open` here is not the benign duplicate it is at arming time: the close above
  // reported success, so a row still open is one the close did not match — and its due
  // date is the expiry of a watch that has ended.
  if (rerecorded.status === 'already_open') {
    console.error(
      { familyId: input.familyId },
      'spot watch: the promise survived its own closure - it is due at an ended watch',
    );
  }
}

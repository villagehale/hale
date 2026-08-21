import type { Database } from '@hale/db';
import {
  type CommitmentCloseOutcome,
  type CommitmentRecordOutcome,
  cancelCommitment,
  fulfillCommitment,
  loadOpenCommitment,
  recordCommitment,
} from '~/lib/commitments/ledger';

/**
 * "I'LL COME BACK TO YOU" IS A ROW — the activity promise on the MEM-10 open-loops ledger.
 *
 * THE INVARIANT: a coach turn that promises to keep looking writes the promise down at
 * SEND TIME, and a sweep owes the family the answer. No unbacked promises.
 *
 * WHAT IT COSTS WHEN IT IS PROSE ONLY. 2026-08-20, 18:14 UTC: a parent asked what their
 * toddler could do from September to December. Hale had nothing offerable to name and
 * said it would come back to them. Nothing was written down — so no sweep could select
 * the family, no digest could count the debt, and the only trace was a sentence in a
 * transcript that compaction is entitled to summarise away. Four minutes later the parent
 * was still asking, and the promise had already ceased to exist anywhere in the system.
 *
 * IT IS A PROMISE, NOT AN OFFER, and the difference is the whole design. `plan_offer` and
 * `checkup_offer` are questions: Hale asks, the parent answers yes, a writer runs. This one
 * asks for nothing. The debt exists the moment the message is sent, whether the parent
 * replies or not, and it is discharged by HALE doing the thing — which is why the sweep
 * fulfils it and no handler resolves it.
 *
 * ONE OPEN PROMISE PER FAMILY, by the ledger's partial unique index rather than by care.
 * A parent who asks about swimming and then about gymnastics is owed ONE follow-up, not
 * two: the newest promise supersedes the older one (`plan_offer` makes the same move for
 * the same reason), because two open rows would be two sweeps texting the same family in
 * the same hour about two halves of one conversation.
 */

/**
 * How long Hale has before the promise is late.
 *
 * TWENTY-FOUR HOURS, and it is not a number invented here: it is what "I'll come back to
 * you" means to the person reading it. The intake radar's own forward beat says "in a day
 * or two" and is due at 48h; this one is a live conversation the parent is in RIGHT NOW,
 * so a day is the outside of what could be called coming back. Past it the row is overdue,
 * which is a query and not a state anything has to remember to write.
 */
export const ACTIVITY_FOLLOWUP_DUE_HOURS = 24;

/**
 * The promise the coach registered: WHAT it will come back about, and for WHOM.
 *
 * `subject` is the DE-IDENTIFIED search subject — the phrase that already cleared phase 0
 * of the lane (scrubbed of every regex-catchable identifier and refused outright if it
 * named anyone in the household). It is stored so the sweep can re-run the same search,
 * which is the only way the promise can be kept by anything other than a human reading
 * the thread.
 */
export interface ActivityPromise {
  subject: string;
  /** Whose search it was, when the parent named one child. Null for a household question. */
  childId: string | null;
}

/** The promise in one short, parent-safe sentence — the ledger's `summary`, and the line
 * the founder digest and the coach's own open-loops recitation read back. */
export function activityFollowUpSummary(subject: string): string {
  return `A promise to come back with what I find on ${subject}`;
}

/**
 * What became of the promise's row. Named rather than void because an unrecorded promise
 * is the exact defect this module exists to make impossible: the parent has been told Hale
 * will come back, and nothing in the system knows it (rule #11).
 */
export type ActivityPromiseRecordOutcome =
  | { status: 'recorded'; commitmentId: string }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'write_failed' | 'already_open' };

export interface ActivityPromisePorts {
  cancelCommitment: typeof cancelCommitment;
  recordCommitment: typeof recordCommitment;
}

export function defaultActivityPromisePorts(): ActivityPromisePorts {
  return { cancelCommitment, recordCommitment };
}

/**
 * Write the promise down, against the message that carried it.
 *
 * SUPERSEDE FIRST, for the reason `recordPlanOffer` states: the partial unique index
 * permits one open promise of a kind per family, so without this a household Hale already
 * owes a find could never be promised another — silently, forever. Superseding is also the
 * honest reading, because the sentence that just went out is the promise now.
 */
export async function recordActivityPromise(
  database: Database,
  input: {
    familyId: string;
    promise: ActivityPromise;
    /** The outbound row that carried the sentence. Null means it never reached a
     * transport, and a promise nobody received is not a promise. */
    channelMessageId: string | null;
    now: Date;
  },
  ports: ActivityPromisePorts,
): Promise<ActivityPromiseRecordOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId },
      'activity promise: no ledger row for the message that carried it - not recorded, this debt is invisible',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }

  await ports.cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    reason: 'activity_promise_superseded',
    now: input.now,
  });

  const outcome: CommitmentRecordOutcome = await ports.recordCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    summary: activityFollowUpSummary(input.promise.subject),
    topic: input.promise.subject,
    subjectChildId: input.promise.childId,
    dueAt: new Date(input.now.getTime() + ACTIVITY_FOLLOWUP_DUE_HOURS * 3_600_000),
    channelMessageId: input.channelMessageId,
  });
  if (outcome.status === 'recorded') {
    return { status: 'recorded', commitmentId: outcome.commitmentId };
  }
  // `already_open` after a successful supersede means the cancel did not match — a lost
  // write, not a duplicate tick. Named as a failure here rather than folded in with the
  // ledger's benign reading of it, because at THIS call site it means the parent was just
  // promised one thing and the sweep will go looking for another.
  console.error(
    { familyId: input.familyId, reason: outcome.status },
    'activity promise: the promise was sent but not recorded - nothing will come back',
  );
  return {
    status: 'not_recorded',
    reason: outcome.status === 'already_open' ? 'already_open' : outcome.reason,
  };
}

/**
 * THE promise this family is still owed, or null.
 *
 * NO TTL, deliberately, and this is where it differs from the two offers that share its
 * table. An offer stops being answerable once the moment has passed, so its reader cuts it
 * off. A promise does not stop being owed by getting late — being late is the whole thing
 * an overdue query measures — so it stays readable until something CLOSES it: the sweep
 * keeping it, or a cancellation with a reason.
 */
export async function loadOpenActivityPromise(
  database: Database,
  familyId: string,
): Promise<{ id: string; summary: string; subject: string } | null> {
  const row = await loadOpenCommitment(database, familyId, 'activity_followup');
  if (!row) return null;
  // A row whose subject is gone cannot be re-searched, so it is not a promise anything can
  // keep. Listed anyway: Hale still said it, and the coach being told it is holding
  // something is better than the parent's next "yes" landing on an unrelated approval.
  return { id: row.id, summary: row.summary, subject: row.topic ?? '' };
}

/**
 * The promise was KEPT — closed against the message that kept it.
 *
 * FULFILLED, NOT CANCELLED, even when what went out was "I looked and could not find it".
 * The promise was to come BACK, not to succeed; coming back empty-handed and saying so
 * keeps it, and filing that as a void would put a false entry in the one ledger that
 * records what Hale actually did.
 */
export async function fulfillActivityPromise(
  database: Database,
  input: { familyId: string; channelMessageId: string | null; now: Date },
): Promise<CommitmentCloseOutcome> {
  return fulfillCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    channelMessageId: input.channelMessageId,
    now: input.now,
  });
}

/**
 * The promise can no longer be kept — voided, with a reason.
 *
 * The one production trigger is a household that has lost its sendable channel: there is
 * no way to come back to somebody who cannot be texted, and leaving the row open would
 * hold a debt nothing can ever discharge — which would also keep the coach reading it as
 * an open loop on every future turn.
 */
export async function cancelActivityPromise(
  database: Database,
  input: { familyId: string; now: Date },
): Promise<CommitmentCloseOutcome> {
  return cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    reason: 'channel_revoked',
    now: input.now,
  });
}

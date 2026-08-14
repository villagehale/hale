import type { Database } from '@hale/db';
import {
  UNDONE_RECEIPT,
  approvedReceipt,
  conflictReply,
  declinedReceipt,
  nothingPendingReply,
  nothingToUndoReply,
  outOfRangeReply,
  whichOneReply,
} from './copy';
import { MAX_LISTED_APPROVALS, type FastPathCommand } from './fast-path';
import { approvalSubjects } from './open-questions';

/**
 * VIL-220 · C1 — resolving a fast-path command against the approvals spine.
 *
 * This is the piece VIL-220 names as "C3's approval resolver". No C3 ticket exists, so
 * it is built here behind {@link ApprovalSpine}: the resolution RULES live in this
 * module and the four database verbs live behind the interface, so C3 can replace the
 * wiring without reopening any of the decisions below.
 *
 * The decisions, in order of how much damage getting them wrong would do:
 *
 *   1. AN AMBIGUOUS AFFIRMATIVE NEVER EXECUTES. With more than one action waiting, a
 *      bare "yes" names none of them. Picking the newest would be a coin flip on a real
 *      calendar write, so the parent is asked which — and asked with a NUMBERED list,
 *      because that is the only thing that makes "YES 2" resolvable at all.
 *
 *   2. AN ORDINAL IS NEVER CLAMPED. "YES 3" against two pending actions is refused, not
 *      rounded down to the second — a parent counting rows in a list they can still see
 *      is more likely mid-typo than off-by-one, and approving the wrong row is
 *      unrecoverable without an undo.
 *
 *   3. A BARE VERB WITH NOTHING PENDING IS NOT CLAIMED AT ALL. This is what stops the
 *      fast-path from swallowing every "yes" a parent ever sends: with no drafted
 *      action there is nothing for the word to mean here, so it falls through to the
 *      handlers behind it (M8's health "yes", and the coach). An ORDINAL is different —
 *      it cannot be conversation — so that one is answered rather than passed on.
 */

/** The minimum an action needs for the fast-path to name it in a text. The TYPE only:
 * the payload can carry a teenager's detail, and nothing here may render it (rule #1). */
export interface PendingAction {
  actionId: string;
  actionType: string;
}

/**
 * Why the spine refused, in the parent's terms rather than the route's.
 *
 * These are STATES, not breakages: the row was already answered (often by the co-parent
 * in the app), it has not cleared Hale's own review (rule #3), the 24h undo window shut,
 * or the last thing Hale did is not a placement it can take back. Every one of them is a
 * permanent, correct refusal, which is what makes "try me again in a minute" false — the
 * next attempt fails identically, and in the already-answered case something DID change.
 *
 * `unavailable` is the one that is genuinely a breakage (the row vanished mid-turn, or
 * came back belonging to another family), and it is the only one the failure template
 * still answers.
 */
export type SpineRefusal =
  | 'already_resolved'
  | 'not_reviewer_approved'
  | 'undo_window_expired'
  | 'not_reversible'
  | 'unavailable';

/** A mutator either did the thing, or says which state stopped it. */
export type SpineOutcome = { ok: true } | { ok: false; reason: SpineRefusal };

/**
 * The four verbs of the approvals spine, injected. Production binds these to the SAME
 * functions the app's approve/decline/undo buttons call, so a text and a tap cannot
 * diverge on preconditions, audit rows, or the reviewer gate (rule #3).
 *
 * Each mutator returns whether it succeeded AND, when it did not, which state refused
 * it. The reason used to be dropped here on the argument that every refusal collapses
 * to one sentence over SMS — but the sentence it collapsed to said Hale had broken and
 * asked the parent to try again, which is false for all four of them.
 */
export interface ApprovalSpine {
  /**
   * This family's drafted actions, OLDEST FIRST. The order is load-bearing: it is what
   * the numbered list prints and what an ordinal resolves against, so it must be stable
   * between the text Hale sent and the reply that answers it. Oldest-first also means a
   * newly drafted action can never renumber the rows a parent is currently reading.
   */
  listPending(database: Database, familyId: string): Promise<PendingAction[]>;
  /** The most recent still-reversible executed action, or null. */
  latestUndoable(database: Database, familyId: string, now: Date): Promise<PendingAction | null>;
  approve(
    database: Database,
    args: { actionId: string; familyId: string; approvedBy: string },
  ): Promise<SpineOutcome>;
  decline(
    database: Database,
    args: { actionId: string; familyId: string; declinedBy: string },
  ): Promise<SpineOutcome>;
  undo(
    database: Database,
    args: { actionId: string; familyId: string; revertedBy: string; now: Date },
  ): Promise<SpineOutcome>;
}

export type ApprovalStatus =
  /** Not an approval at all — the router must try the next handler. */
  | 'declined_to_claim'
  | 'approved'
  | 'declined'
  | 'undone'
  | 'ambiguous'
  | 'out_of_range'
  | 'nothing_pending'
  | 'nothing_to_undo'
  /** The spine refused (already resolved, outside the undo window, reviewer gate). */
  | 'conflict';

export interface ApprovalOutcome {
  status: ApprovalStatus;
  /** What to text back, or null when the message was not claimed. */
  reply: string | null;
  /** The action acted on, when exactly one was. */
  actionId: string | null;
}

const notClaimed: ApprovalOutcome = { status: 'declined_to_claim', reply: null, actionId: null };

export async function resolveApproval(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    command: FastPathCommand;
    now: Date;
    /**
     * The action the router's natural-reply stage decided this message names
     * (lib/channel/router/resolve.ts) — "yes to the swim move" instead of "YES 2".
     *
     * BY ID, NEVER BY POSITION, and that is the whole reason this is a separate field
     * rather than a synthesised ordinal. The pending list is read twice on such a turn
     * (once to describe the questions, once here to act), and a co-parent approving
     * something in the app between those two reads shifts every ordinal by one. An id
     * cannot shift. Decision 2 above — an ordinal is never clamped — becomes: a named
     * action that is no longer pending is never silently swapped for its neighbour.
     */
    targetActionId?: string;
  },
  spine: ApprovalSpine,
): Promise<ApprovalOutcome> {
  if (input.command.verb === 'undo') {
    return resolveUndo(database, input, spine);
  }

  const pending = await spine.listPending(database, input.familyId);
  const target =
    input.targetActionId === undefined
      ? pick(pending, input.command.index)
      : (pending.find((action) => action.actionId === input.targetActionId) ?? 'gone');

  if (target === 'gone') {
    // It was pending when the questions were read and is not now, so somebody answered
    // it — overwhelmingly the co-parent, in the app. That is a real state and it has a
    // true sentence; inventing a retry would be the failure this receipt class replaced.
    return {
      status: 'conflict',
      reply: conflictReply('already_resolved'),
      actionId: input.targetActionId ?? null,
    };
  }

  if (target === 'out_of_range') {
    // Reached only when an ordinal was given and the list is shorter (or empty).
    return pending.length === 0
      ? { status: 'nothing_pending', reply: nothingPendingReply(), actionId: null }
      : { status: 'out_of_range', reply: outOfRangeReply(pending.length), actionId: null };
  }
  if (target === 'ambiguous') {
    return {
      status: 'ambiguous',
      reply: whichOneReply(approvalSubjects(pending)),
      actionId: null,
    };
  }
  if (target === null) {
    return notClaimed;
  }

  const approving = input.command.verb === 'yes';
  const outcome = approving
    ? await spine.approve(database, {
        actionId: target.actionId,
        familyId: input.familyId,
        approvedBy: input.parentUserId,
      })
    : await spine.decline(database, {
        actionId: target.actionId,
        familyId: input.familyId,
        declinedBy: input.parentUserId,
      });

  if (!outcome.ok) {
    return { status: 'conflict', reply: conflictReply(outcome.reason), actionId: target.actionId };
  }
  return {
    status: approving ? 'approved' : 'declined',
    reply: approving ? approvedReceipt(target.actionType) : declinedReceipt(target.actionType),
    actionId: target.actionId,
  };
}

/**
 * Which action a verb names.
 *
 * `null` means "no claim" (a bare verb with nothing pending); the two string verdicts
 * are the refusals that still owe the parent an answer. They are distinct returns
 * rather than a thrown error because each maps to different copy.
 */
function pick(
  pending: PendingAction[],
  index: number | null,
): PendingAction | null | 'ambiguous' | 'out_of_range' | 'gone' {
  if (index !== null) {
    return pending[index - 1] ?? 'out_of_range';
  }
  if (pending.length === 0) return null;
  if (pending.length === 1) return pending[0] as PendingAction;
  return 'ambiguous';
}

/**
 * Undo names the last thing Hale DID, so it never consults the pending queue — and it
 * always claims the message. "Undo" cannot be read as conversation, so passing it to
 * the coach could only produce a vaguer version of the same answer, and the honest
 * "there is nothing to undo" is one the router can give without a model.
 *
 * The window (24h, calendar placements only) belongs to the spine, not here: it is the
 * same gate the app's undo enforces, and a second copy of it would be a second copy
 * that can drift.
 */
async function resolveUndo(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
  spine: ApprovalSpine,
): Promise<ApprovalOutcome> {
  const target = await spine.latestUndoable(database, input.familyId, input.now);
  if (!target) {
    return { status: 'nothing_to_undo', reply: nothingToUndoReply(), actionId: null };
  }

  const outcome = await spine.undo(database, {
    actionId: target.actionId,
    familyId: input.familyId,
    revertedBy: input.parentUserId,
    now: input.now,
  });
  return outcome.ok
    ? { status: 'undone', reply: UNDONE_RECEIPT, actionId: target.actionId }
    : { status: 'conflict', reply: conflictReply(outcome.reason), actionId: target.actionId };
}

/** Re-exported so a caller reasoning about the numbered list has one import. */
export { MAX_LISTED_APPROVALS };

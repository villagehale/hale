import { formatDateTime } from '~/lib/format/datetime';
import { type ApprovalView, type PendingApprovalRow, toApprovalView } from './approvals';

/**
 * The Approvals HISTORY view — a past, resolved action (executed autonomously,
 * declined, reverted, or held for a human), newest first. It reuses the LIVE
 * Approvals card's teen-safe fields via toApprovalView (actionType, preview,
 * summary, payload) so History and the live queue render the SAME intent label and
 * apply the SAME rule-#1 redaction: a 13+ child's raw payload never reaches a
 * history row (teenContent → the placeholder + null payload, structurally).
 *
 * Beyond the live card, a history row carries its resolved `status` and the
 * `resolvedAt` stamp so the list reads as a settled record, not a pending decision.
 */

export type HistoryStatus = 'executed' | 'declined' | 'reverted' | 'held' | 'failed';

export interface HistoryActionRow extends PendingApprovalRow {
  /** The action's terminal user-visible state (never 'drafted_for_approval' — those
   * live in the pending queue, not history). */
  userVisibleState: 'autonomous' | 'needs_human' | 'reverted';
  /** Set once the action executed (autonomous path). */
  executedAt: Date | null;
  /** Why a reverted action was reverted, e.g. 'declined_by_human'. */
  revertedReason: string | null;
  /** When the action reached its resolved state — executedAt / revertedAt /
   * verdictAt — for the "when" stamp. Falls back to draftedAt. */
  resolvedAt: Date;
}

export interface HistoryView extends ApprovalView {
  /** The resolved status, driving the row's status chip. */
  status: HistoryStatus;
  /** Family-zone stamp of when the action resolved. */
  resolvedAt: string;
}

/**
 * The action's resolved status from its terminal state. A declined draft lands in
 * 'reverted' with reason 'declined_by_human' (see decline.ts) — distinguished from
 * a later revert so the chip reads "Declined" vs "Reverted". An executed action is
 * 'autonomous' with an executedAt.
 *
 * 'needs_human' is overloaded: recordReview leaves it with executedAt null (a draft
 * HELD for a human decision), while recordExecution stamps it WITH an executedAt when
 * an approved action failed mid-execution (input.ok false). The executedAt tells the
 * two apart — a failed run reads 'failed' so the failure is disclosed, never a calm
 * 'held'.
 */
export function historyStatus(row: HistoryActionRow): HistoryStatus {
  if (row.userVisibleState === 'autonomous') return 'executed';
  if (row.userVisibleState === 'needs_human') return row.executedAt !== null ? 'failed' : 'held';
  return row.revertedReason === 'declined_by_human' ? 'declined' : 'reverted';
}

export function toHistoryView(row: HistoryActionRow, timeZone: string): HistoryView {
  return {
    ...toApprovalView(row, timeZone),
    status: historyStatus(row),
    resolvedAt: formatDateTime(row.resolvedAt, timeZone),
  };
}

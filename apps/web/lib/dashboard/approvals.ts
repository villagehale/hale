import { TEEN_REDACTED_PLACEHOLDER } from './mappers';

/**
 * Pure row → view-shape mapper for the Approvals page — the pending drafted
 * actions a parent must approve before Hale ever acts (rule #4: this is the only
 * path to execution for an L1/L2 family).
 *
 * Hard rule #1 (teen privacy): when the action's event concerns a 13+ child, the
 * parent sees only the action category + the reviewer's verdict — never the raw
 * drafted payload (which can quote the teen's content). `teenContent` is an
 * EXPLICIT input so redaction is structural: the raw payload never reaches the
 * view shape once the flag is true.
 */

export interface PendingApprovalRow {
  id: string;
  actionType: string;
  payload: Record<string, unknown>;
  reviewerVerdict: string;
  draftedAt: Date;
  teenContent: boolean;
}

export interface ApprovalView {
  id: string;
  actionType: string;
  /** A one-line, non-raw summary safe to show — the reviewer's verdict framing. */
  summary: string;
  /** The drafted payload, or null when redacted for teen privacy (rule #1). */
  payload: Record<string, unknown> | null;
  verdict: string;
  draftedAt: string;
}

const DRAFTED_DATE = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Toronto',
});

const VERDICT_SUMMARY: Record<string, string> = {
  approved: 'verified by the reviewer — ready for your approval',
  flagged: 'flagged for your review',
  rejected: 'the reviewer raised a concern — review before approving',
  pending: 'awaiting review',
  superseded: 'replaced by a newer draft',
};

export function toApprovalView(row: PendingApprovalRow): ApprovalView {
  const summary = VERDICT_SUMMARY[row.reviewerVerdict] ?? 'awaiting your approval';
  return {
    id: row.id,
    actionType: row.actionType,
    summary: row.teenContent ? TEEN_REDACTED_PLACEHOLDER : summary,
    payload: row.teenContent ? null : row.payload,
    verdict: row.reviewerVerdict,
    draftedAt: DRAFTED_DATE.format(row.draftedAt),
  };
}

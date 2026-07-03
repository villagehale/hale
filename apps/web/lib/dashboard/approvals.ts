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
  /** The child the draft is about, or null for a whole-family / unattributed draft. */
  childId: string | null;
  /** The attributed child's given name, or null for a whole-family draft OR a 13+
   * child whose name the query withholds (rule #1) — never the raw teen name. */
  childLabel: string | null;
}

export interface ApprovalView {
  id: string;
  actionType: string;
  /** A one-line, non-raw summary safe to show — the reviewer's verdict framing. */
  summary: string;
  /**
   * A short, human-legible line describing what the draft does, derived per
   * actionType from its payload (e.g. "Reply to Dr. Chen — confirm Tuesday 3pm")
   * so the parent reads intent, not raw JSON. Redacted to the placeholder for a
   * 13+ child (rule #1) — the raw payload never reaches it.
   */
  preview: string;
  /** The drafted payload, or null when redacted for teen privacy (rule #1). */
  payload: Record<string, unknown> | null;
  /** The child the draft is about (null = whole family), for the row's child tag. */
  childId: string | null;
  /** The tag's given name, or null for whole family / a name-withheld teen (rule #1). */
  childLabel: string | null;
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

/** Reads a payload string field, trimmed; null when absent or not a non-empty string. */
function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A one-line, human-legible description of what a drafted action does, built from
 * the action's most salient payload fields. The closed actionType set maps to a
 * verb + object; an absent salient field degrades to a readable label (the draft
 * isn't fully filled in — a valid boundary, not an error). NEVER called on the
 * teen-content branch, so no raw teen payload reaches a preview.
 */
function derivePreview(actionType: string, payload: Record<string, unknown>): string {
  switch (actionType) {
    case 'reply_to_email': {
      const to = field(payload, 'to');
      const subject = field(payload, 'subject');
      if (to && subject) return `Reply to ${to} — ${subject}`;
      if (to) return `Reply to ${to}`;
      return 'Reply to an email';
    }
    case 'send_email': {
      const to = field(payload, 'to');
      const subject = field(payload, 'subject');
      if (to && subject) return `Email ${to} — ${subject}`;
      if (to) return `Email ${to}`;
      return 'Send an email';
    }
    case 'create_calendar_event':
    case 'update_calendar_event': {
      const title = field(payload, 'title');
      const verb = actionType === 'create_calendar_event' ? 'Add to calendar' : 'Update calendar';
      return title ? `${verb} — ${title}` : verb;
    }
    case 'place_supply_order':
    case 'cancel_supply_order': {
      const item = field(payload, 'item');
      const verb = actionType === 'place_supply_order' ? 'Order' : 'Cancel order';
      return item ? `${verb} ${item}` : `${verb} a supply`;
    }
    case 'share_photos_with_family':
      return 'Share photos with family';
    case 'add_to_digest_only':
      return 'Note in your daily digest';
    case 'add_to_routine':
      return 'Pin to your routine';
    default:
      return actionType.replaceAll('_', ' ');
  }
}

export function toApprovalView(row: PendingApprovalRow): ApprovalView {
  const summary = VERDICT_SUMMARY[row.reviewerVerdict] ?? 'awaiting your approval';
  return {
    id: row.id,
    actionType: row.actionType,
    summary: row.teenContent ? TEEN_REDACTED_PLACEHOLDER : summary,
    preview: row.teenContent
      ? TEEN_REDACTED_PLACEHOLDER
      : derivePreview(row.actionType, row.payload),
    payload: row.teenContent ? null : row.payload,
    childId: row.childId,
    childLabel: row.childLabel,
    verdict: row.reviewerVerdict,
    draftedAt: DRAFTED_DATE.format(row.draftedAt),
  };
}

import { formatDateTime } from '~/lib/format/datetime';
import { actionTypeLabel } from '~/lib/format/labels';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';

/**
 * Pure row → view-shape mappers for the mobile Messages inbox — "Hale's notes to
 * you": the reverse-chron feed of the family's daily digests + the action
 * lifecycle a parent should see (a draft awaiting their yes, something Hale did,
 * something that needs them). Kept free of I/O so the redaction + copy logic is
 * unit-testable; the loader does the querying and passes rows in.
 *
 * Hard rule #1 (teen privacy): an ACTION row that concerns a 13+ child is
 * redacted structurally — `teenContent` is an EXPLICIT input, and when true the
 * raw drafted payload never reaches the preview (it degrades to the shared
 * placeholder). The DIGEST brief is already a parent-facing, pre-redacted slice
 * (daily-digests.ts: "no raw teen content — rule #1"), so it surfaces as written.
 */

export type MessageKind = 'digest' | 'action';

/** The action lifecycle states a parent sees in the feed — a subset of the
 * action_user_visible_state enum, each with its own parent-facing framing. A
 * drafted row is the only one that navigates (to Approvals); the rest are notes. */
export type MessageActionState =
  | 'drafted_for_approval'
  | 'autonomous'
  | 'needs_human'
  | 'reverted';

export interface MessageView {
  id: string;
  kind: MessageKind;
  /** Short eyebrow — "Daily brief" for a digest, the action category for an action. */
  eyebrow: string;
  /** The note's one line: the digest brief prose, or the lifecycle framing. */
  body: string;
  /** The family-zone timestamp the row is stamped with. */
  when: string;
  /** For an action row: the lifecycle state, so the screen knows a drafted row
   * navigates to Approvals. Absent on a digest row. */
  actionState?: MessageActionState;
  /** True when the action's content is redacted for a 13+ teen (rule #1). */
  teenRedacted?: boolean;
}

export interface DigestMessageRow {
  id: string;
  briefText: string;
  generatedAt: Date;
}

export interface ActionMessageRow {
  id: string;
  actionType: string;
  state: MessageActionState;
  /** The instant the row is stamped by — reverted_at/executed_at when it settled,
   * else drafted_at. */
  at: Date;
  /** Why a 'reverted' row is in that state — 'declined_by_human' means the parent
   * refused a draft that never ran (decline.ts), NOT a rollback of an executed
   * action. Absent for non-reverted rows. */
  revertedReason: string | null;
  teenContent: boolean;
}

/** The lifecycle framing a parent reads, built from the (already human) action
 * label. NEVER called on the teen branch — the label can echo the action type,
 * which for a teen row is withheld to the placeholder before this runs. */
function actionBody(row: ActionMessageRow, label: string): string {
  switch (row.state) {
    case 'drafted_for_approval':
      return `Hale drafted "${label}" for your yes.`;
    case 'autonomous':
      return `Hale handled "${label}".`;
    case 'needs_human':
      return `"${label}" needs you.`;
    case 'reverted':
      // A declined draft never ran — framing it as a rollback would claim the
      // parent undid an action that never happened (decline.ts parks refused
      // drafts here). Frame the refusal honestly; a true revert of an executed
      // action keeps the rollback copy.
      return row.revertedReason === 'declined_by_human'
        ? `You declined "${label}".`
        : `You rolled back "${label}".`;
  }
}

const DIGEST_EYEBROW = 'Daily brief';

export function toDigestMessage(row: DigestMessageRow, timeZone: string): MessageView {
  return {
    id: `digest-${row.id}`,
    kind: 'digest',
    eyebrow: DIGEST_EYEBROW,
    body: row.briefText,
    when: formatDateTime(row.generatedAt, timeZone),
  };
}

export function toActionMessage(row: ActionMessageRow, timeZone: string): MessageView {
  const label = row.teenContent ? TEEN_REDACTED_PLACEHOLDER : actionTypeLabel(row.actionType);
  return {
    id: `action-${row.id}`,
    kind: 'action',
    eyebrow: row.teenContent ? 'Private' : actionTypeLabel(row.actionType),
    body: row.teenContent ? TEEN_REDACTED_PLACEHOLDER : actionBody(row, label),
    when: formatDateTime(row.at, timeZone),
    actionState: row.state,
    teenRedacted: row.teenContent,
  };
}

import type { Route } from 'next';
import { actionTypeLabel } from '~/lib/format/labels';
import type { MessageView } from '~/lib/messages/mappers';
import { loadMessages } from '~/lib/messages/queries';
import type { ApprovalView } from './approvals';
import { loadPendingApprovals } from './queries';

/**
 * One row in the top-bar notification bell (design handoff §3.2). Both the unread
 * dot and the dropdown read the SAME items: pending approvals (the actionable
 * "waiting for you" set) + Hale's recent notes. Teen content arrives already
 * redacted from the loaders (rule #1) — a redacted approval/message carries only
 * its placeholder, never raw content.
 */
export interface NotificationItem {
  /** Stable per underlying record, so the client's "seen" watermark is precise. */
  id: string;
  eyebrow: string;
  body: string;
  href: Route;
}

const APPROVALS_HREF: Route = '/approvals';
const MESSAGES_HREF: Route = '/messages';

/** How many of Hale's recent notes to fold into the bell alongside the approvals. */
const MESSAGE_LIMIT = 6;

/**
 * Pure approvals + messages → bell items. A drafted-for-approval action shows up in
 * BOTH loaders (the approvals queue AND the messages feed) — the message copy of it
 * is dropped here so the same action never appears twice; the approval item is the
 * one that leads to a decision.
 */
export function toNotificationItems(
  approvals: ApprovalView[],
  messages: MessageView[],
): NotificationItem[] {
  const approvalItems: NotificationItem[] = approvals.map((approval) => ({
    id: `approval-${approval.id}`,
    eyebrow: approval.teenRedacted ? 'Private' : actionTypeLabel(approval.actionType),
    body: approval.preview,
    href: APPROVALS_HREF,
  }));

  const messageItems: NotificationItem[] = messages
    .filter((message) => message.actionState !== 'drafted_for_approval')
    .slice(0, MESSAGE_LIMIT)
    .map((message) => ({
      id: message.id,
      eyebrow: message.eyebrow,
      body: message.body,
      href: MESSAGES_HREF,
    }));

  return [...approvalItems, ...messageItems];
}

/**
 * The bell's notifications for the authed shell. Same empty-state degradation as
 * the loaders it composes (no DB / no resolved family → empty), so the bell simply
 * shows "all caught up".
 */
export async function loadNotifications(): Promise<NotificationItem[]> {
  const [approvals, messages] = await Promise.all([loadPendingApprovals(), loadMessages()]);
  return toNotificationItems(approvals, messages);
}

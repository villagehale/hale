import { describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from './approvals';
import type { MessageView } from '~/lib/messages/mappers';

// notifications.ts statically imports the two loaders, which pull the auth/db
// chain (next-auth). We only exercise the pure toNotificationItems, so stub the
// loaders to keep the module graph off the network/DB.
vi.mock('~/lib/messages/queries', () => ({ loadMessages: vi.fn() }));
vi.mock('./queries', () => ({ loadPendingApprovals: vi.fn() }));

const { toNotificationItems } = await import('./notifications');

function approval(over: Partial<ApprovalView>): ApprovalView {
  return {
    id: 'a1',
    actionType: 'book_checkup',
    summary: '',
    preview: 'Book the 15-month well-baby visit',
    payload: null,
    childId: null,
    childLabel: null,
    verdict: 'approved',
    draftedAt: '2026-07-19',
    teenRedacted: false,
    ...over,
  } as ApprovalView;
}

function message(over: Partial<MessageView>): MessageView {
  return {
    id: 'm1',
    eyebrow: 'Hale',
    body: 'Your weekly summary is ready',
    ...over,
  } as MessageView;
}

describe('toNotificationItems', () => {
  it('leads with approvals, then folds in messages', () => {
    const items = toNotificationItems(
      [approval({ id: 'a1', preview: 'Add to calendar' })],
      [message({ id: 'm1', body: 'A note from Hale' })],
    );
    expect(items.map((i) => i.id)).toEqual(['approval-a1', 'm1']);
    expect(items.map((i) => i.href)).toEqual(['/approvals', '/messages']);
  });

  it('drops the message copy of a drafted-for-approval action so it never appears twice', () => {
    const items = toNotificationItems(
      [approval({ id: 'a1' })],
      [
        message({ id: 'm-draft', actionState: 'drafted_for_approval', body: 'dup of the approval' }),
        message({ id: 'm-note', body: 'a real note' }),
      ],
    );
    expect(items.map((i) => i.id)).toEqual(['approval-a1', 'm-note']);
  });

  it("shows a teen-redacted approval as 'Private', never the raw action label", () => {
    const items = toNotificationItems(
      [approval({ id: 'a1', teenRedacted: true, actionType: 'send_email' })],
      [],
    );
    expect(items[0]?.eyebrow).toBe('Private');
  });

  it('caps the folded-in messages at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => message({ id: `m${i}` }));
    const items = toNotificationItems([], many);
    expect(items).toHaveLength(6);
  });
});

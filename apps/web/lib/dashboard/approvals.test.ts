import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from './mappers';
import { type PendingApprovalRow, toApprovalView } from './approvals';

const BASE: PendingApprovalRow = {
  id: '33333333-3333-4333-8333-333333333333',
  actionType: 'reply_to_email',
  payload: {},
  reviewerVerdict: 'approved',
  draftedAt: new Date('2026-06-17T15:00:00.000Z'),
  teenContent: false,
  childId: null,
  childLabel: null,
};

const TZ = 'America/Toronto';

describe('toApprovalView — human preview (A1)', () => {
  it('previews a reply with recipient + subject, not raw JSON', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'reply_to_email',
        payload: { to: 'Dr. Chen', subject: 'confirm Tuesday 3pm', body: 'See you then.' },
      },
      TZ,
    );
    expect(view.preview).toBe('Reply to Dr. Chen — confirm Tuesday 3pm');
    // 15:00 UTC is 11:00 in America/Toronto (EDT) — drafted-at reads in the family zone.
    expect(view.draftedAt).toBe('Jun 17, 11:00');
  });

  it('previews a new email with recipient + subject', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'send_email',
        payload: { to: 'daycare@example.com', subject: 'pickup change', body: '...' },
      },
      TZ,
    );
    expect(view.preview).toBe('Email daycare@example.com — pickup change');
  });

  it('previews a calendar event with its title', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'create_calendar_event',
        payload: { title: '6-month checkup', start: '2026-07-01T14:00:00Z' },
      },
      TZ,
    );
    expect(view.preview).toBe('Add to calendar — 6-month checkup');
  });

  it('previews a supply order with the item', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'place_supply_order',
        payload: { item: 'size 3 diapers' },
      },
      TZ,
    );
    expect(view.preview).toBe('Order size 3 diapers');
  });

  it('falls back to a readable label when the salient field is absent', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'reply_to_email',
        payload: {},
      },
      TZ,
    );
    expect(view.preview).toBe('Reply to an email');
  });

  it('redacts the preview entirely for teen content (rule #1) — raw never reaches the view', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'reply_to_email',
        payload: { to: 'Coach Ramirez', subject: 'about Maya' },
        teenContent: true,
      },
      TZ,
    );
    expect(view.preview).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.payload).toBeNull();
    expect(JSON.stringify(view)).not.toContain('Maya');
    expect(JSON.stringify(view)).not.toContain('Coach Ramirez');
  });

  it('marks the row teenRedacted and shows the private placeholder EXACTLY once (no double placeholder, policy 3)', () => {
    const view = toApprovalView(
      { ...BASE, actionType: 'reply_to_email', payload: { to: 'X' }, teenContent: true },
      TZ,
    );
    expect(view.teenRedacted).toBe(true);
    // The placeholder is the single locked "what" — the summary must NOT repeat it.
    expect(view.preview).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.summary).not.toBe(TEEN_REDACTED_PLACEHOLDER);
    const occurrences = [view.preview, view.summary].filter(
      (s) => s === TEEN_REDACTED_PLACEHOLDER,
    ).length;
    expect(occurrences).toBe(1);
  });

  it('leaves a non-teen row un-redacted (teenRedacted false, verdict summary intact)', () => {
    const view = toApprovalView({ ...BASE, reviewerVerdict: 'approved' }, TZ);
    expect(view.teenRedacted).toBe(false);
    expect(view.summary).toBe('verified by the reviewer — ready for your approval');
  });
});

describe('toApprovalView — which child the draft is about (rule #1)', () => {
  const CHILD = '44444444-4444-4444-8444-444444444444';

  it('carries a whole-family draft through as childId null (no child attributed)', () => {
    const view = toApprovalView(BASE, TZ);
    expect(view.childId).toBeNull();
    expect(view.childLabel).toBeNull();
  });

  it('carries a non-teen child id + given name through unchanged', () => {
    const view = toApprovalView({ ...BASE, childId: CHILD, childLabel: 'Nadia' }, TZ);
    expect(view.childId).toBe(CHILD);
    expect(view.childLabel).toBe('Nadia');
  });

  it('never surfaces a teen name — the withheld label arrives as null (childId set)', () => {
    // The query withholds a 13+ child's given name before the row reaches the
    // mapper (rule #1): childId identifies the draft's child, childLabel is null.
    const view = toApprovalView(
      { ...BASE, childId: CHILD, childLabel: null, teenContent: true },
      TZ,
    );
    expect(view.childId).toBe(CHILD);
    expect(view.childLabel).toBeNull();
    expect(JSON.stringify(view)).not.toContain('Maya');
  });
});

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

/**
 * VIL-260 · WS3b — a redacted row is only ASKABLE if there is a teen to ask.
 *
 * The approvals page offered "ask to see this" on every redacted row. POST
 * /api/teen-content-grant resolves the action's teen child and 404s when the row names
 * none, so on an unattributed row the button was a permanent dead end: the parent
 * typed a reason, submitted, and got an error, forever, with no way to decide the
 * card. Assent is per-child (rule #5) and the content was never attributed, so there
 * is no honest way to ask — the surface has to say that instead of offering a door
 * that does not open.
 */
describe('toApprovalView — whether a redacted row can be unlocked at all', () => {
  const CHILD = '44444444-4444-4444-8444-444444444444';

  it('is askable when the redacted row names the teen it concerns', () => {
    const view = toApprovalView({ ...BASE, teenContent: true, childId: CHILD }, TZ);
    expect(view.teenRedacted).toBe(true);
    expect(view.teenUnlockable).toBe(true);
  });

  it('is NOT askable when the redaction came from the family fallback (no child named)', () => {
    const view = toApprovalView({ ...BASE, teenContent: true, childId: null }, TZ);
    expect(view.teenRedacted).toBe(true);
    expect(view.teenUnlockable).toBe(false);
  });

  it('is not askable when nothing is redacted — there is nothing to ask about', () => {
    const view = toApprovalView({ ...BASE, teenContent: false, childId: CHILD }, TZ);
    expect(view.teenUnlockable).toBe(false);
  });
});

/**
 * VIL-260 · WS3 — the card has to say WHAT it is, now that the draft carries it.
 *
 * Every internal-write draft previewed as its bare category — "Note in your daily
 * digest" for a municipal registration shortlist, and three identical "Add to your
 * calendar" lines for calendar_add / move / cancel, because those three fell through
 * to the generic actionType label. A parent approving a quiet-hours-exempt SMS ladder
 * off a line reading "Note in your daily digest" is approving something the card never
 * described.
 */
describe('toApprovalView — the preview names the drafted item', () => {
  it('names the registration shortlist instead of the generic digest category', () => {
    const view = toApprovalView(
      {
        ...BASE,
        actionType: 'add_to_digest_only',
        payload: {
          intentKind: 'registration_shortlist',
          title: 'Burlington recreation programs and swim lessons',
          summary: 'Registration opens Saturday. I never register for you.',
          source_url: 'https://www.burlington.ca/registering',
        },
      },
      TZ,
    );
    expect(view.preview).toBe(
      'Note in your digest — Burlington recreation programs and swim lessons',
    );
  });

  it('still degrades to the category when the draft has no title', () => {
    const view = toApprovalView({ ...BASE, actionType: 'add_to_digest_only', payload: {} }, TZ);
    expect(view.preview).toBe('Note in your daily digest');
  });

  it('names the pinned item on a routine draft', () => {
    const view = toApprovalView(
      { ...BASE, actionType: 'add_to_routine', payload: { title: 'Help me book: 18-month visit' } },
      TZ,
    );
    expect(view.preview).toBe('Pin to your routine — Help me book: 18-month visit');
  });

  it('distinguishes the three calendar placements and reads the time in the family zone', () => {
    const payload = { title: 'Swim lesson', startsAt: '2026-07-01T14:00:00.000Z' };
    // 14:00 UTC is 10:00 in America/Toronto — a parent never reads a raw UTC stamp.
    expect(toApprovalView({ ...BASE, actionType: 'calendar_add', payload }, TZ).preview).toBe(
      'Add to your calendar — Swim lesson, Jul 1, 10:00',
    );
    expect(toApprovalView({ ...BASE, actionType: 'calendar_move', payload }, TZ).preview).toBe(
      'Reschedule on your calendar — Swim lesson, Jul 1, 10:00',
    );
    expect(
      toApprovalView({ ...BASE, actionType: 'calendar_cancel', payload: { title: 'Swim lesson' } }, TZ)
        .preview,
    ).toBe('Remove from your calendar — Swim lesson');
  });
});

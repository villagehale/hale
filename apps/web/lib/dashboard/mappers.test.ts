import { describe, expect, it } from 'vitest';
import {
  type Action,
  type AuditLogEntry,
  TEEN_REDACTED_PLACEHOLDER,
  toDigestEntry,
  toDigestTally,
  toDraftView,
  toTrailView,
} from './mappers.js';

function action(overrides: Partial<Action>): Action {
  return {
    id: 'a1',
    eventId: 'e1',
    familyId: 'f1',
    actionType: 'send_email',
    payload: {},
    draftedAt: new Date('2026-06-11T10:00:00Z'),
    draftedByAgentRunId: null,
    reviewerVerdict: 'pending',
    reviewerVerdictAt: null,
    reviewerToolResults: [],
    executedAt: null,
    executorResult: null,
    userVisibleState: 'drafted_for_approval',
    revertedAt: null,
    revertedReason: null,
    ...overrides,
  } as Action;
}

describe('toDraftView', () => {
  it('pulls recipient/subject/body/rationale out of the action payload', () => {
    const view = toDraftView(
      action({
        id: 'draft-1',
        actionType: 'reply_to_email',
        payload: {
          recipient: 'Toronto Public Library',
          subject: 'baby story-time, saturday',
          body: 'Saturday at ten thirty works.',
          rationale: 'they sent an invite; matched your tone.',
        },
      }),
      false,
    );

    expect(view).toEqual({
      id: 'draft-1',
      recipient: 'Toronto Public Library',
      category: 'reply_to_email',
      subject: 'baby story-time, saturday',
      body: 'Saturday at ten thirty works.',
      rationale: 'they sent an invite; matched your tone.',
    });
  });

  it('falls back to placeholders when payload fields are missing', () => {
    const view = toDraftView(action({ id: 'draft-2', actionType: 'place_supply_order', payload: {} }), false);

    expect(view.recipient).toBe('unspecified recipient');
    expect(view.subject).toBe('place_supply_order');
    expect(view.body).toBe('');
    expect(view.rationale).toBe('');
  });
});

describe('toDigestTally', () => {
  it('counts each user-visible state into its lane and ignores reverted', () => {
    const tally = toDigestTally([
      { userVisibleState: 'autonomous' },
      { userVisibleState: 'autonomous' },
      { userVisibleState: 'drafted_for_approval' },
      { userVisibleState: 'needs_human' },
      { userVisibleState: 'reverted' },
    ]);

    expect(tally).toEqual({ handled: 2, awaiting: 1, needsYou: 1 });
  });

  it('returns all-zero for an empty day', () => {
    expect(toDigestTally([])).toEqual({ handled: 0, awaiting: 0, needsYou: 0 });
  });
});

describe('toDigestEntry', () => {
  it('maps autonomous → done tone with the payload body', () => {
    const entry = toDigestEntry(
      action({ id: 'd1', userVisibleState: 'autonomous', payload: { body: 'reordered diapers.' } }),
      false,
    );
    expect(entry).toEqual({ id: 'd1', tone: 'done', category: 'send_email', body: 'reordered diapers.' });
  });

  it('maps needs_human → needs-you tone, synthesizing a body when none', () => {
    const entry = toDigestEntry(
      action({ id: 'd2', actionType: 'fill_pdf_form', userVisibleState: 'needs_human', payload: {} }),
      false,
    );
    expect(entry).toEqual({
      id: 'd2',
      tone: 'needs-you',
      category: 'fill_pdf_form',
      body: 'fill_pdf_form · needs_human',
    });
  });

  it('drops reverted actions (returns null)', () => {
    expect(toDigestEntry(action({ userVisibleState: 'reverted' }), false)).toBeNull();
  });
});

function auditEntry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 'log-1',
    familyId: 'f1',
    actor: 'system',
    actionTaken: 'sent rsvp to library',
    targetTable: 'actions',
    targetId: 'act-9',
    before: null,
    after: null,
    occurredAt: new Date('2026-06-11T14:05:00Z'),
    ip: null,
    userAgent: null,
    agentRunId: null,
    ...overrides,
  } as AuditLogEntry;
}

describe('toTrailView', () => {
  it('renders a system actor as hale with a Toronto-time stamp', () => {
    // 14:05 UTC is 10:05 in America/Toronto (EDT, UTC-4) on 2026-06-11.
    const view = toTrailView(auditEntry({ actor: 'system' }), false);
    expect(view.actor).toBe('hale');
    expect(view.time).toBe('10:05');
    expect(view.summary).toBe('sent rsvp to library');
    expect(view.detail).toBe('actions · act-9');
  });

  it('renders a non-system actor as a parent ("you")', () => {
    const view = toTrailView(auditEntry({ actor: 'user-uuid-123' }), false);
    expect(view.actor).toBe('you');
  });

  it('falls back to "recorded" detail when no target id is present', () => {
    const view = toTrailView(auditEntry({ targetId: null, targetTable: null }), false);
    expect(view.detail).toBe('recorded');
    expect(view.category).toBe('action');
  });
});

// ── Rule #1: teen content (children 13+) is redacted at the mapper layer ──────
// The parent sees CATEGORY + Hale's own rationale + a "kept private" placeholder,
// NEVER the teen's raw body/subject/quoted text. teenContent is an EXPLICIT mapper
// input so the redaction is structural — a future caller that forgets to JOIN
// events still cannot leak raw teen text once the flag is set.
describe('teen-content redaction', () => {
  const TEEN_BODY = 'Mom I think I might be failing math, please do not tell dad';
  const TEEN_SUBJECT = 're: your son is struggling in period 4';

  describe('toDraftView', () => {
    it('drops raw subject/body and keeps category + recipient + rationale when teen-content', () => {
      const view = toDraftView(
        action({
          id: 'draft-teen',
          actionType: 'reply_to_email',
          payload: {
            recipient: 'Riverdale Secondary School',
            subject: TEEN_SUBJECT,
            body: TEEN_BODY,
            rationale: 'replying to the school about your teenager.',
          },
        }),
        true,
      );

      // No raw teen text anywhere in the serialized view.
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(TEEN_BODY);
      expect(serialized).not.toContain(TEEN_SUBJECT);

      // Category + non-sensitive recipient + Hale's rationale survive; body/subject
      // become the placeholder so the parent can authorize on category alone (L2).
      expect(view.category).toBe('reply_to_email');
      expect(view.recipient).toBe('Riverdale Secondary School');
      expect(view.rationale).toBe('replying to the school about your teenager.');
      expect(view.body).toBe(TEEN_REDACTED_PLACEHOLDER);
      expect(view.subject).toBe(TEEN_REDACTED_PLACEHOLDER);
    });

    it('renders the full body/subject as today when NOT teen-content', () => {
      const view = toDraftView(
        action({
          id: 'draft-1',
          actionType: 'reply_to_email',
          payload: {
            recipient: 'Toronto Public Library',
            subject: 'baby story-time, saturday',
            body: 'Saturday at ten thirty works.',
            rationale: 'they sent an invite; matched your tone.',
          },
        }),
        false,
      );
      expect(view.body).toBe('Saturday at ten thirty works.');
      expect(view.subject).toBe('baby story-time, saturday');
    });
  });

  describe('toDigestEntry', () => {
    it('drops the raw body and keeps category + tone when teen-content', () => {
      const entry = toDigestEntry(
        action({
          id: 'd-teen',
          actionType: 'reply_to_email',
          userVisibleState: 'drafted_for_approval',
          payload: { body: TEEN_BODY },
        }),
        true,
      );
      expect(entry).not.toBeNull();
      expect(JSON.stringify(entry)).not.toContain(TEEN_BODY);
      expect(entry?.category).toBe('reply_to_email');
      expect(entry?.tone).toBe('awaiting');
      expect(entry?.body).toBe(TEEN_REDACTED_PLACEHOLDER);
    });

    it('renders the full body as today when NOT teen-content', () => {
      const entry = toDigestEntry(
        action({ id: 'd1', userVisibleState: 'autonomous', payload: { body: 'reordered diapers.' } }),
        false,
      );
      expect(entry?.body).toBe('reordered diapers.');
    });
  });

  describe('toTrailView', () => {
    it('drops the raw summary and keeps category/actor/time when teen-content', () => {
      const view = toTrailView(
        auditEntry({ actor: 'system', actionTaken: TEEN_BODY, targetTable: 'actions', targetId: 'act-teen' }),
        true,
      );
      expect(JSON.stringify(view)).not.toContain(TEEN_BODY);
      expect(view.actor).toBe('hale');
      expect(view.category).toBe('actions');
      expect(view.time).toBe('10:05');
      expect(view.summary).toBe(TEEN_REDACTED_PLACEHOLDER);
    });

    it('renders the full summary as today when NOT teen-content', () => {
      const view = toTrailView(auditEntry({ actor: 'system' }), false);
      expect(view.summary).toBe('sent rsvp to library');
    });
  });
});

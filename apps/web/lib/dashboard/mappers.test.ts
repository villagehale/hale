import { describe, expect, it } from 'vitest';
import {
  type Action,
  type AuditLogEntry,
  type Event,
  type MemoryFact,
  TEEN_REDACTED_PLACEHOLDER,
  toDigestEntry,
  toDigestTally,
  toDraftView,
  toLiveSignal,
  toMemoryFactView,
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
    const view = toDraftView(
      action({ id: 'draft-2', actionType: 'place_supply_order', payload: {} }),
      false,
    );

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
    expect(entry).toEqual({
      id: 'd1',
      tone: 'done',
      category: 'send_email',
      body: 'reordered diapers.',
    });
  });

  it('maps needs_human → needs-you tone, synthesizing a body when none', () => {
    const entry = toDigestEntry(
      action({
        id: 'd2',
        actionType: 'fill_pdf_form',
        userVisibleState: 'needs_human',
        payload: {},
      }),
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
        action({
          id: 'd1',
          userVisibleState: 'autonomous',
          payload: { body: 'reordered diapers.' },
        }),
        false,
      );
      expect(entry?.body).toBe('reordered diapers.');
    });
  });

  describe('toTrailView', () => {
    it('drops the raw summary and keeps category/actor/time when teen-content', () => {
      const view = toTrailView(
        auditEntry({
          actor: 'system',
          actionTaken: TEEN_BODY,
          targetTable: 'actions',
          targetId: 'act-teen',
        }),
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

function event(overrides: Partial<Event>): Event {
  return {
    id: 'ev1',
    familyId: 'f1',
    source: 'gmail',
    sourceExternalId: null,
    eventType: 'email_received',
    childId: null,
    payload: {},
    classifierSuggestion: null,
    teenContent: false,
    rawSignalRef: null,
    classifiedAt: null,
    classifierConfidence: null,
    dedupHash: 'h1',
    status: 'classified',
    receivedAt: new Date('2026-06-11T14:05:00Z'),
    updatedAt: new Date('2026-06-11T14:05:00Z'),
    ...overrides,
  } as Event;
}

describe('toLiveSignal', () => {
  it('takes its tone + decision from the drafted action', () => {
    const view = toLiveSignal(
      event({ source: 'stripe', payload: { summary: 'diaper subscription renewed.' } }),
      action({ userVisibleState: 'autonomous' }),
    );
    // 14:05 UTC is 10:05 in America/Toronto on 2026-06-11.
    expect(view).toEqual({
      id: 'ev1',
      at: '10:05',
      source: 'stripe',
      tone: 'done',
      summary: 'diaper subscription renewed.',
      decision: 'handled on your behalf',
    });
  });

  it('reads an observe-only event (no action) as a quiet note', () => {
    const view = toLiveSignal(
      event({ payload: { summary: 'longest sleep stretch logged.' } }),
      null,
    );
    expect(view.tone).toBe('coach');
    expect(view.decision).toBe('observed · no action taken');
    expect(view.summary).toBe('longest sleep stretch logged.');
  });

  it('falls back to subject, then event type, when no summary', () => {
    expect(toLiveSignal(event({ payload: { subject: 'lab results' } }), null).summary).toBe(
      'lab results',
    );
    expect(toLiveSignal(event({ eventType: 'photo_added', payload: {} }), null).summary).toBe(
      'photo_added',
    );
  });

  it('redacts summary and decision for teen-content, keeping source + tone + time', () => {
    const TEEN = 'mom please do not tell dad I am failing math';
    const view = toLiveSignal(
      event({ teenContent: true, source: 'gmail', payload: { summary: TEEN } }),
      action({ userVisibleState: 'drafted_for_approval' }),
    );
    expect(JSON.stringify(view)).not.toContain(TEEN);
    expect(view.source).toBe('gmail');
    expect(view.tone).toBe('awaiting');
    expect(view.at).toBe('10:05');
    expect(view.summary).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.decision).toBe(TEEN_REDACTED_PLACEHOLDER);
  });
});

function memoryFact(overrides: Partial<MemoryFact>): MemoryFact {
  return {
    id: 'm1',
    familyId: 'f1',
    childId: null,
    factType: 'preference',
    factKey: 'pediatric appointments',
    factValue: 'family prefers Thursday mornings',
    confidence: 0.92,
    sourceEventId: null,
    inferredBy: 'memory_inferencer',
    validFrom: new Date('2026-06-01T00:00:00Z'),
    validUntil: null,
    supersededBy: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  } as MemoryFact;
}

describe('toMemoryFactView', () => {
  it('maps a string fact value straight through with its type/key/source/confidence', () => {
    const view = toMemoryFactView(memoryFact({}));
    expect(view).toEqual({
      id: 'm1',
      type: 'preference',
      key: 'pediatric appointments',
      value: 'family prefers Thursday mornings',
      source: 'memory_inferencer',
      confidence: 0.92,
    });
  });

  it('serializes a structured fact value so the family still sees what was stored', () => {
    const view = toMemoryFactView(
      memoryFact({ factValue: { tuesday: 'parent A', other: 'parent B' } }),
    );
    expect(view.value).toBe('{"tuesday":"parent A","other":"parent B"}');
  });

  it('labels provenance generically when inferredBy is absent', () => {
    expect(toMemoryFactView(memoryFact({ inferredBy: null })).source).toBe('observed by Hale');
  });
});

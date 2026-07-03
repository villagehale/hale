import { describe, expect, it } from 'vitest';
import { type AuditLogEntry, TEEN_REDACTED_PLACEHOLDER, toTrailView } from './mappers.js';

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
  it('stamps the time in the family zone it is given', () => {
    // 14:05 UTC is 10:05 in America/Toronto (EDT, UTC-4) on 2026-06-11.
    const view = toTrailView(auditEntry({ actor: 'system' }), false, 'America/Toronto');
    expect(view.actor).toBe('hale');
    expect(view.time).toBe('10:05');
    expect(view.summary).toBe('sent rsvp to library');
    expect(view.detail).toBe('actions · act-9');
  });

  it('honours a non-Toronto family zone — the zone is used, not hardcoded', () => {
    // Same 14:05 UTC instant reads 07:05 in Vancouver (PDT, UTC-7).
    const view = toTrailView(auditEntry({ actor: 'system' }), false, 'America/Vancouver');
    expect(view.time).toBe('07:05');
  });

  it('renders a non-system actor as a parent ("you")', () => {
    const view = toTrailView(auditEntry({ actor: 'user-uuid-123' }), false, 'America/Toronto');
    expect(view.actor).toBe('you');
  });

  it('falls back to "recorded" detail when no target id is present', () => {
    const view = toTrailView(
      auditEntry({ targetId: null, targetTable: null }),
      false,
      'America/Toronto',
    );
    expect(view.detail).toBe('recorded');
    expect(view.category).toBe('action');
  });
});

// ── Rule #1: teen content (children 13+) is redacted at the mapper layer ──────
// The parent sees CATEGORY + actor + time + a "kept private" placeholder, NEVER
// the teen's raw quoted text. teenContent is an EXPLICIT mapper input so the
// redaction is structural — a future caller that forgets to JOIN events still
// cannot leak raw teen text once the flag is set.
describe('toTrailView — teen-content redaction', () => {
  const TEEN_BODY = 'Mom I think I might be failing math, please do not tell dad';

  it('drops the raw summary and keeps category/actor/time when teen-content', () => {
    const view = toTrailView(
      auditEntry({
        actor: 'system',
        actionTaken: TEEN_BODY,
        targetTable: 'actions',
        targetId: 'act-teen',
      }),
      true,
      'America/Toronto',
    );
    expect(JSON.stringify(view)).not.toContain(TEEN_BODY);
    expect(view.actor).toBe('hale');
    expect(view.category).toBe('actions');
    expect(view.time).toBe('10:05');
    expect(view.summary).toBe(TEEN_REDACTED_PLACEHOLDER);
  });

  it('renders the full summary when NOT teen-content', () => {
    const view = toTrailView(auditEntry({ actor: 'system' }), false, 'America/Toronto');
    expect(view.summary).toBe('sent rsvp to library');
  });
});

import { describe, expect, it } from 'vitest';
import {
  type ActorResolver,
  type AuditLogEntry,
  TEEN_REDACTED_PLACEHOLDER,
  toTrailView,
} from './mappers.js';

function auditEntry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 'log-1',
    familyId: 'f1',
    actor: 'system',
    actionTaken: 'action.executed',
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

const PRIMARY = 'user-primary-uuid';
const CO_PARENT = 'user-coparent-uuid';

/** A resolver that knows exactly two humans; everyone else is Hale. */
const resolve: ActorResolver = (actor) => {
  if (actor === PRIMARY) return 'you';
  if (actor === CO_PARENT) return 'co-parent';
  return 'hale';
};

// A fixed "now" a year AFTER the fixture instant, so the day heading carries the
// year deterministically (the code's default `now` is the wall clock).
const NOW = new Date('2027-06-01T12:00:00Z');

function trail(overrides: Partial<AuditLogEntry>, teen = false, tz = 'America/Toronto') {
  return toTrailView(auditEntry(overrides), teen, tz, resolve, null, NOW);
}

describe('toTrailView — the honest frame', () => {
  it('stamps the time + day heading + day key in the family zone it is given', () => {
    // 14:05 UTC is 10:05 in America/Toronto (EDT, UTC-4) on Thu 2026-06-11.
    const view = trail({});
    expect(view.time).toBe('10:05');
    expect(view.date).toBe('Thursday, Jun 11, 2026');
    expect(view.dayKey).toBe('2026-06-11');
  });

  it('honours a non-Toronto family zone — the zone is used, not hardcoded', () => {
    // Same 14:05 UTC instant reads 07:05 in Vancouver (PDT, UTC-7).
    expect(trail({}, false, 'America/Vancouver').time).toBe('07:05');
  });

  it('turns the stored verb into a human sentence, never the raw token', () => {
    expect(trail({ actionTaken: 'action.executed' }).summary).toBe('carried out the action');
    expect(trail({ actionTaken: 'plan_created' }).summary).toBe('you added a plan');
  });

  it('turns the target table into a domain noun + a deep link, never a bare id', () => {
    const view = trail({ targetTable: 'actions', targetId: 'act-9' });
    expect(view.noun).toBe('draft');
    expect(view.link).toBe('/approvals');
    expect(JSON.stringify(view)).not.toContain('act-9');
  });

  it('shows a noun with no link when the target has no viewable surface', () => {
    const view = trail({ targetTable: 'events', targetId: 'evt-1' });
    expect(view.noun).toBe('signal');
    expect(view.link).toBeNull();
  });

  it('derives the row tone from the verb family — a failure never reads done', () => {
    expect(trail({ actionTaken: 'action.executed' }).tone).toBe('done');
    expect(trail({ actionTaken: 'action.execution_failed' }).tone).not.toBe('done');
    expect(trail({ actionTaken: 'event.dropped.spend_ceiling' }).tone).not.toBe('done');
  });
});

// ── Actor resolution (rule: an unknown UUID is NEVER a human) ─────────────────
describe('toTrailView — actor resolution', () => {
  it('reads a system actor as Hale', () => {
    expect(trail({ actor: 'system' }).actor).toBe('hale');
  });

  it('reads a known family member as you / co-parent by role', () => {
    expect(trail({ actor: PRIMARY }).actor).toBe('you');
    expect(trail({ actor: CO_PARENT }).actor).toBe('co-parent');
  });

  it('NEVER defaults an unknown UUID (an agent run, a stale id) to a human — it reads Hale', () => {
    expect(trail({ actor: 'a2c1e0f4-agent-run-uuid' }).actor).toBe('hale');
    expect(trail({ actor: 'some-user-who-left-the-family' }).actor).toBe('hale');
  });
});

// ── Rule #1: teen content (children 13+) is redacted at the mapper layer ──────
// The parent sees CATEGORY + actor + time + a "kept private" placeholder, NEVER
// the teen's raw quoted text. teenContent is an EXPLICIT mapper input so the
// redaction is structural — a future caller that forgets to JOIN events still
// cannot leak raw teen text once the flag is set.
describe('toTrailView — teen-content redaction', () => {
  const TEEN_BODY = 'Mom I think I might be failing math, please do not tell dad';

  it('drops the summary and keeps the frame when teen-content', () => {
    const view = trail({ actionTaken: TEEN_BODY, targetTable: 'actions', targetId: 'act-teen' }, true);
    expect(JSON.stringify(view)).not.toContain(TEEN_BODY);
    expect(view.summary).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.actor).toBe('hale');
    expect(view.noun).toBe('draft');
    expect(view.time).toBe('10:05');
  });

  it('keeps the human sentence when NOT teen-content', () => {
    expect(trail({ actionTaken: 'action.executed' }, false).summary).toBe('carried out the action');
  });
});

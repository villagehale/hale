import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER, type TrailView } from './mappers';

/**
 * Rule #1 DOUBLE-MISS at the History trail query layer (end-to-end over a fake db),
 * including the `resolvedToEvent` boundary the approvals path doesn't have.
 *
 * Two rows in a family WITH a teen:
 *  - an EVENT-resolved audit row (teen_content=false, childDob=null) — the double-miss
 *    → redacted (family fallback).
 *  - a NON-event audit row (teen_content=null, e.g. a family-settings change) → kept
 *    in full, because the family fallback must NOT blanket-redact rows that don't
 *    even resolve to an event just because the family has a teenager.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_DOB = '2011-01-01'; // teenager
// The event-resolved row's verb (an executed reply) and the non-event row's verb
// (a family-settings change). Both humanize through the verb layer; the rule-#1
// assertion is on which one gets the redaction PLACEHOLDER.
const REPLY_VERB = 'action.executed';
const SETTINGS_VERB = 'plan_created';
const REPLY_SENTENCE = 'carried out the action';
const SETTINGS_SENTENCE = 'you added a plan';

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => FAMILY_ID }));

function auditEntry(overrides: Record<string, unknown>) {
  return {
    id: 'log-x',
    familyId: FAMILY_ID,
    actor: 'system',
    actionTaken: 'placeholder',
    targetTable: 'actions',
    targetId: 'act-1',
    before: null,
    after: null,
    occurredAt: new Date('2026-06-20T14:00:00Z'),
    ip: null,
    userAgent: null,
    agentRunId: null,
    ...overrides,
  };
}

// Row 1: resolved to an event (teenContent non-null=false), unattributed → double-miss.
// Row 2: NOT resolved to an event (teenContent null) → non-`actions` target boundary.
const TRAIL_ROWS = [
  {
    entry: auditEntry({ id: 'log-1', actionTaken: REPLY_VERB }),
    teenContent: false,
    childDob: null,
    childName: null,
  },
  {
    entry: auditEntry({ id: 'log-2', actionTaken: SETTINGS_VERB, targetTable: 'families' }),
    teenContent: null,
    childDob: null,
    childName: null,
  },
];

function fakeDb(childrenDob: Array<{ dateOfBirth: string }>) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => childrenDob }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      // The time layer's primary-parent timezone read (loadFamilyTimezone).
      return {
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        }),
      };
    }
    if (keys.length === 2 && keys.includes('userId') && keys.includes('role')) {
      // The actor resolver's family-member read (buildActorResolver): no members
      // → every actor (including 'system') resolves to Hale.
      return { from: () => ({ where: async () => [] }) };
    }
    const node = () =>
      Object.assign(Promise.resolve(TRAIL_ROWS), {
        limit: () => Promise.resolve(TRAIL_ROWS),
        orderBy: () => node(),
      });
    return {
      from: () => ({
        leftJoin: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => node() }) }) }),
      }),
    };
  });
  return { select } as never;
}

let currentChildrenDob: Array<{ dateOfBirth: string }> = [];
vi.mock('~/lib/db', () => ({ db: () => fakeDb(currentChildrenDob) }));

const { loadTrail } = await import('./queries');

describe('loadTrail — rule #1 double-miss family fallback + resolvedToEvent boundary', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test';
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
  });

  it('redacts the unattributed event-resolved row in a teen family but keeps the non-event audit row', async () => {
    currentChildrenDob = [{ dateOfBirth: TEEN_DOB }];
    const views = await loadTrail();

    const eventRow = views.find((v) => v.id === 'log-1');
    const settingsRow = views.find((v) => v.id === 'log-2');

    // Double-miss: redacted by the family fallback.
    expect(eventRow?.summary).toBe(TEEN_REDACTED_PLACEHOLDER);

    // Non-event audit row keeps its (humanized) summary — not blanket-redacted.
    expect(settingsRow?.summary).toBe(SETTINGS_SENTENCE);
  });

  it('keeps both rows in full when the family has NO teen', async () => {
    currentChildrenDob = [{ dateOfBirth: '2024-05-01' }]; // toddler only
    const views = await loadTrail();
    expect(views.find((v) => v.id === 'log-1')?.summary).toBe(REPLY_SENTENCE);
    expect(views.find((v) => v.id === 'log-2')?.summary).toBe(SETTINGS_SENTENCE);
  });

  it('never surfaces a raw actor uuid as a human — a system row reads Hale', async () => {
    currentChildrenDob = [];
    const views: TrailView[] = await loadTrail();
    // No family members in the fake db → the 'system' actor resolves to Hale,
    // and every row's actor is one of the three known labels (never a raw id).
    expect(views.every((v) => ['hale', 'you', 'co-parent'].includes(v.actor))).toBe(true);
    expect(views.find((v) => v.id === 'log-1')?.actor).toBe('hale');
  });
});

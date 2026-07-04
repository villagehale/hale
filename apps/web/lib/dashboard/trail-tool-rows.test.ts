import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrailView } from './mappers';

/**
 * The Ask Hale agent writes an audit_log row per guarded tool call
 * (action_taken = `tool:<name>`, see packages/agent/src/tool.ts). Those rows are
 * internal SUB-STEPS of an Ask, not parent-facing actions: they must NOT reach the
 * /trail timeline (they'd render as meaningless "recorded an action" rows and leak
 * the raw snake_case tool identifier's shape), and must NOT be counted in the /trail
 * tally. This exercises the exclusion end-to-end over the fake db.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const REAL_VERB = 'action.executed';
const REAL_SENTENCE = 'carried out the action';

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => FAMILY_ID }));

function auditEntry(overrides: Record<string, unknown>) {
  return {
    id: 'log-x',
    familyId: FAMILY_ID,
    actor: 'system',
    actionTaken: 'placeholder',
    targetTable: null,
    targetId: null,
    before: null,
    after: null,
    occurredAt: new Date('2026-06-20T14:00:00Z'),
    ip: null,
    userAgent: null,
    agentRunId: null,
    ...overrides,
  };
}

// A real parent-facing action + two internal agent tool sub-steps.
const TRAIL_ROWS = [
  { entry: auditEntry({ id: 'real', actionTaken: REAL_VERB }), teenContent: null, childDob: null, childName: null },
  {
    entry: auditEntry({ id: 'tool-1', actionTaken: 'tool:get_framework_guidance' }),
    teenContent: null,
    childDob: null,
    childName: null,
  },
  {
    entry: auditEntry({ id: 'tool-2', actionTaken: 'tool:get_child_profile' }),
    teenContent: null,
    childDob: null,
    childName: null,
  },
];

// The fake db returns EVERY audit row (including the tool:* sub-steps), ignoring the
// WHERE predicate — so the test proves the production code, not the fake, drops the
// tool rows (red-before-green): without the exclusion, tool-1 / tool-2 would surface.
function fakeDb() {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => [] }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      return { from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    }
    if (keys.length === 2 && keys.includes('userId') && keys.includes('role')) {
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

vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));

const { loadTrail } = await import('./queries');

describe('loadTrail — internal agent tool-call rows never reach the trail', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test';
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
  });

  it('excludes tool:* audit sub-steps and keeps the real action', async () => {
    const views: TrailView[] = await loadTrail();

    expect(views.map((v) => v.id)).toEqual(['real']);
    expect(views.find((v) => v.id === 'real')?.summary).toBe(REAL_SENTENCE);
    // No raw tool identifier (or its snake_case shape) can reach a summary.
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain('tool:');
    expect(serialized).not.toContain('get_child_profile');
    expect(serialized).not.toContain('get_framework_guidance');
  });
});

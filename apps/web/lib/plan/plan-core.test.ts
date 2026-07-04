import { schema } from '@hale/db';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { completePlanForFamily, insertPlanForFamily, validatePlan } from './plan-core';

const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OWN_CHILD_ID = '55555555-5555-4555-8555-555555555555';
const FOREIGN_CHILD_ID = '66666666-6666-4666-8666-666666666666';
const NEW_PLAN_ID = '77777777-7777-4777-8777-777777777777';

interface InsertRecord {
  table: unknown;
  values: Record<string, unknown>;
}

/**
 * In-memory fake of the narrow tx surface insertPlanForFamily uses:
 *  - select(children).where(id = ?, family_id = ?).limit(1) → the family-scope
 *    check. `owned` seeds which (childId, familyId) pairs exist, mirroring the
 *    real where-clause: a childId is "owned" only when it's paired with the
 *    caller's family.
 *  - insert(family_plans).values(...).returning() → returns the new plan id.
 *  - insert(audit_log).values(...) → recorded, not returned.
 * Every insert's {table, values} is captured so the test can assert the audit
 * row and the (absent) private override.
 */
function fakeDb(owned: Array<{ childId: string; familyId: string }>) {
  const inserts: InsertRecord[] = [];

  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: (marker: { childId: string; familyId: string }) => ({
          limit: async () => {
            const match = owned.find(
              (o) => o.childId === marker.childId && o.familyId === marker.familyId,
            );
            return match ? [{ id: match.childId }] : [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      // The plan insert awaits .returning(); the audit insert awaits .values(...)
      // directly. So values() returns a thenable (a resolved Promise, for the
      // audit path) that also carries .returning() (for the plan path).
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
          returning: () => Promise<Array<{ id: string }>>;
        };
        awaitable.returning = async () => [{ id: NEW_PLAN_ID }];
        return awaitable;
      },
    })),
  };

  const database = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;

  return { database, inserts };
}

// eq/and → markers the select fake can read back the (childId, familyId) it
// filtered on, since the fake ignores drizzle's real column objects.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ col: col?.name, val }),
    and: (...parts: Array<{ col?: string; val: unknown }>) => {
      const marker: Record<string, unknown> = {};
      for (const part of parts) {
        if (part.col === 'id') marker.childId = part.val;
        if (part.col === 'family_id') marker.familyId = part.val;
      }
      return marker;
    },
  };
});

function planFor(childId: string | null) {
  return { title: 'swimming registration', notes: null, scheduledFor: null, childId };
}

describe('insertPlanForFamily — family-scoping', () => {
  it('rejects a child_id from another family and writes nothing', async () => {
    // The foreign child exists, but only under OTHER_FAMILY_ID — so the caller's
    // family-scoped lookup finds no owned row.
    const { database, inserts } = fakeDb([
      { childId: FOREIGN_CHILD_ID, familyId: OTHER_FAMILY_ID },
    ]);

    const result = await insertPlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      plan: planFor(FOREIGN_CHILD_ID),
    });

    expect(result).toEqual({ status: 'foreign_child' });
    // No plan row, no audit row — the rejection is before any write.
    expect(inserts).toHaveLength(0);
  });

  it('creates the plan for a child the family owns', async () => {
    const { database, inserts } = fakeDb([{ childId: OWN_CHILD_ID, familyId: FAMILY_ID }]);

    const result = await insertPlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      plan: planFor(OWN_CHILD_ID),
    });

    expect(result).toEqual({ status: 'created', planId: NEW_PLAN_ID });
    const planInsert = inserts.find((i) => i.table === schema.familyPlans);
    expect(planInsert?.values.childId).toBe(OWN_CHILD_ID);
    expect(planInsert?.values.familyId).toBe(FAMILY_ID);
  });
});

describe('insertPlanForFamily — audit trail (rule #6)', () => {
  it('writes an audit_log row inside the same transaction as the plan', async () => {
    const { database, inserts } = fakeDb([]);

    await insertPlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      plan: planFor(null),
    });

    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.values).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'plan_created',
      targetTable: 'family_plans',
      targetId: NEW_PLAN_ID,
    });
  });
});

describe('private defaults true', () => {
  it('never passes a private override, so the column default (true) stands', async () => {
    const { database, inserts } = fakeDb([]);

    await insertPlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      plan: planFor(null),
    });

    const planInsert = inserts.find((i) => i.table === schema.familyPlans);
    // The insert must not force private off; the value is left to the DB default.
    expect(planInsert?.values.private).toBeUndefined();
  });

  it('the family_plans.private column default is true', () => {
    const columns = getTableColumns(schema.familyPlans);
    expect(columns.private.default).toBe(true);
    expect(columns.private.notNull).toBe(true);
  });
});

/**
 * Fake for completePlanForFamily's narrow tx surface:
 *  - update(family_plans).set(...).where(marker).returning() → the family-scoped
 *    stamp. `liveMatches` seeds which planIds resolve to a LIVE (not-yet-done) row
 *    for the caller's family; a miss returns [] (foreign or already-done → no stamp).
 *  - insert(audit_log).values(...) → recorded, not returned.
 * Every insert's {table, values} and the update .set payload are captured.
 */
function completeFakeDb(liveMatches: string[]) {
  const inserts: InsertRecord[] = [];
  const updates: Array<{ set: Record<string, unknown> }> = [];

  const tx = {
    update: vi.fn(() => ({
      set: (set: Record<string, unknown>) => ({
        // The mocked `and` (top of file) maps a col==='id' clause to marker.childId,
        // so the plan id arrives there; family_id → marker.familyId.
        where: (marker: { childId?: string; familyId?: string }) => ({
          returning: async () => {
            const hit =
              marker.childId !== undefined &&
              marker.familyId === FAMILY_ID &&
              liveMatches.includes(marker.childId);
            if (hit) updates.push({ set });
            return hit ? [{ id: marker.childId }] : [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return Promise.resolve(undefined);
      },
    })),
  };

  const database = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;

  return { database, inserts, updates };
}

const PLAN_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-07-03T12:00:00Z');

describe('completePlanForFamily', () => {
  it('stamps completed_at and writes ONE plan_completed audit row for an owned, open plan', async () => {
    const { database, inserts, updates } = completeFakeDb([PLAN_ID]);

    const result = await completePlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      planId: PLAN_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: 'completed' });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set.completedAt).toBe(NOW);

    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(auditInsert?.values).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'plan_completed',
      targetTable: 'family_plans',
      targetId: PLAN_ID,
    });
    // Exactly one write to audit_log — no second row.
    expect(inserts.filter((i) => i.table === schema.auditLog)).toHaveLength(1);
  });

  it('returns not_found and writes nothing for a plan not live in this family (foreign or already done)', async () => {
    // No live match → the family-scoped, completed_at-IS-NULL update stamps nothing.
    const { database, inserts, updates } = completeFakeDb([]);

    const result = await completePlanForFamily(database, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      planId: PLAN_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: 'not_found' });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('validatePlan', () => {
  it('rejects a blank title', () => {
    expect(validatePlan({ title: '   ', notes: null, scheduledFor: null, childId: null })).toEqual({
      ok: false,
      error: 'title_required',
    });
  });

  it('rejects an unparseable scheduled date', () => {
    expect(
      validatePlan({ title: 'x', notes: null, scheduledFor: 'not-a-date', childId: null }),
    ).toEqual({ ok: false, error: 'scheduled_for_invalid' });
  });

  it('trims the title and empties blank notes to null', () => {
    const result = validatePlan({
      title: '  swim  ',
      notes: '   ',
      scheduledFor: null,
      childId: OWN_CHILD_ID,
    });
    expect(result).toEqual({
      ok: true,
      plan: { title: 'swim', notes: null, scheduledFor: null, childId: OWN_CHILD_ID },
    });
  });
});

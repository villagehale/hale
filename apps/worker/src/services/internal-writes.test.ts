import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { addToDigest, addToRoutine } from './internal-writes.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const PRIMARY_PARENT_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_ID = '55555555-5555-4555-8555-555555555555';
const NEW_PLAN_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-07-05T09:00:00.000Z');

interface InsertRecord {
  table: unknown;
  values: Record<string, unknown>;
}

/**
 * Fake of the narrow tx surface the internal writes use, dispatched by the table
 * each select/insert targets:
 *  - select(family_members) → the primary_parent user id (or [] if none).
 *  - select(events)         → the event's child_id.
 *  - select(audit_log)      → the idempotency probe: pre-seed `priorAudit` with an
 *    already-written audit action to simulate a re-drain.
 *  - insert(family_plans).returning() → the new plan id.
 *  - insert(audit_log)      → recorded (recordTransition writes this).
 * Every insert's {table, values} is captured so the test asserts the plan row and
 * its audit row landed in the SAME transaction.
 */
function fakeDb(opts: {
  primaryParentId: string | null;
  childId: string | null;
  priorAuditActions?: string[];
}) {
  const inserts: InsertRecord[] = [];
  const priorAuditActions = opts.priorAuditActions ?? [];

  const tx = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.familyMembers) {
              return opts.primaryParentId ? [{ userId: opts.primaryParentId }] : [];
            }
            if (table === schema.events) {
              return [{ childId: opts.childId }];
            }
            if (table === schema.auditLog) {
              // Idempotency probe: the fake can't read the WHERE, so it keys off
              // the projected `id` column being requested against audit_log. We
              // return a hit iff ANY prior audit action was seeded — the caller
              // seeds exactly the action under test.
              return priorAuditActions.length > 0 ? [{ id: 'prior-audit' }] : [];
            }
            return [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
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

  // recordTransition runs its body inside database.transaction(...).
  const database = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;

  return { database, inserts };
}

function itemInput() {
  return {
    familyId: FAMILY_ID,
    actionId: ACTION_ID,
    eventId: EVENT_ID,
    title: 'Baby & Me Yoga',
    notes: 'Tuesdays 10am',
  };
}

describe('addToRoutine — pins to the current week plan + audit (rules #6)', () => {
  it('inserts a dated family_plans row and its audit row in one transaction', async () => {
    const { database, inserts } = fakeDb({ primaryParentId: PRIMARY_PARENT_ID, childId: CHILD_ID });

    const outcome = await addToRoutine(itemInput(), NOW, database);
    expect(outcome).toBe('written');

    const planInsert = inserts.find((i) => i.table === schema.familyPlans);
    expect(planInsert?.values).toMatchObject({
      familyId: FAMILY_ID,
      createdBy: PRIMARY_PARENT_ID,
      childId: CHILD_ID,
      title: 'Baby & Me Yoga',
      notes: 'Tuesdays 10am',
      scheduledFor: NOW,
    });

    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(auditInsert?.values).toMatchObject({
      familyId: FAMILY_ID,
      actor: 'system',
      actionTaken: 'action.routine_pinned',
      targetTable: 'family_plans',
      targetId: NEW_PLAN_ID,
    });
  });

  it('is idempotent on a re-drain: the prior audit row suppresses a second plan write', async () => {
    const { database, inserts } = fakeDb({
      primaryParentId: PRIMARY_PARENT_ID,
      childId: CHILD_ID,
      priorAuditActions: ['action.routine_pinned'],
    });

    const outcome = await addToRoutine(itemInput(), NOW, database);
    expect(outcome).toBe('already_written');

    // No new family_plans row — only the skipped-duplicate audit row.
    expect(inserts.find((i) => i.table === schema.familyPlans)).toBeUndefined();
    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(auditInsert?.values.actionTaken).toBe('action.routine_pinned.skipped_duplicate');
  });

  it('throws (never a false success) when the family has no primary parent to attribute the plan', async () => {
    const { database, inserts } = fakeDb({ primaryParentId: null, childId: CHILD_ID });

    await expect(addToRoutine(itemInput(), NOW, database)).rejects.toThrow(/no primary_parent/);
    expect(inserts.find((i) => i.table === schema.familyPlans)).toBeUndefined();
  });
});

describe('addToDigest — undated note + audit (rule #6)', () => {
  it('inserts an UNDATED family_plans row (scheduledFor null) and a digest_noted audit row', async () => {
    const { database, inserts } = fakeDb({ primaryParentId: PRIMARY_PARENT_ID, childId: null });

    const outcome = await addToDigest(itemInput(), database);
    expect(outcome).toBe('written');

    const planInsert = inserts.find((i) => i.table === schema.familyPlans);
    expect(planInsert?.values.scheduledFor).toBeNull();
    expect(planInsert?.values.childId).toBeNull();

    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(auditInsert?.values.actionTaken).toBe('action.digest_noted');
    expect(auditInsert?.values.targetTable).toBe('family_plans');
  });

  it('is idempotent on a re-drain (prior digest_noted audit → no second write)', async () => {
    const { database, inserts } = fakeDb({
      primaryParentId: PRIMARY_PARENT_ID,
      childId: null,
      priorAuditActions: ['action.digest_noted'],
    });

    const outcome = await addToDigest(itemInput(), database);
    expect(outcome).toBe('already_written');
    expect(inserts.find((i) => i.table === schema.familyPlans)).toBeUndefined();
  });
});

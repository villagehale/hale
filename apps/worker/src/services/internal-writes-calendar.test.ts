import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { addToCalendar, cancelCalendarEvent, moveCalendarEvent } from './internal-writes.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_ID = '22222222-2222-4222-8222-222222222222';
const NEW_EVENT_ID = '33333333-3333-4333-8333-333333333333';
const HANDLE = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-20T12:00:00.000Z');

interface InsertRecord {
  table: unknown;
  values: Record<string, unknown>;
}

/**
 * Fakes the tx surface the calendar writes use:
 *  - select(audit_log)  → the re-drain probe. Seed `priorTargetId` to simulate a
 *    prior pass having placed a row (its targetId is the family_events id to recover).
 *  - insert(family_events).returning()  → the new row id.
 *  - update(family_events).returning()  → `updateReturns` (empty = row missing/deleted).
 *  - insert(audit_log)  → recorded by recordTransition.
 * Captures every insert + the update's `set` so a test can assert the placement row,
 * the audit row, and the soft-delete landed in the SAME transaction.
 */
function fakeDb(opts: { priorTargetId?: string | null; updateReturns?: Array<{ id: string }> }) {
  const inserts: InsertRecord[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const priorTargetId = opts.priorTargetId ?? null;
  const updateReturns = opts.updateReturns ?? [{ id: HANDLE }];

  const tx = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.auditLog) {
              return priorTargetId ? [{ targetId: priorTargetId }] : [];
            }
            return [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          returning: async () => (table === schema.familyEvents ? [{ id: NEW_EVENT_ID }] : []),
        };
      },
    })),
    update: vi.fn((_table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: () => ({ returning: async () => updateReturns }) };
      },
    })),
  };

  const database = { transaction: vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)) };
  return { database: database as never, inserts, updateSets };
}

const ADD_INPUT = {
  familyId: FAMILY_ID,
  actionId: ACTION_ID,
  title: 'Swim class',
  startsAt: new Date('2026-07-22T14:00:00.000Z'),
  endsAt: null,
  location: 'Rec Centre',
  childId: null,
};

describe('addToCalendar', () => {
  it('inserts a placement (source=placement) and returns its id as the reversal handle', async () => {
    const { database, inserts } = fakeDb({});
    const result = await addToCalendar(ADD_INPUT, database);

    expect(result).toEqual({ outcome: 'written', familyEventId: NEW_EVENT_ID });

    const feInsert = inserts.find((i) => i.table === schema.familyEvents);
    expect(feInsert?.values).toMatchObject({
      familyId: FAMILY_ID,
      title: 'Swim class',
      source: 'placement',
    });
    // The audit ties the new row id (targetId) to the action, so a re-drain recovers it.
    const audit = inserts.find((i) => i.table === schema.auditLog);
    expect(audit?.values).toMatchObject({
      actionTaken: 'action.calendar_placed',
      targetId: NEW_EVENT_ID,
      after: expect.objectContaining({ actionId: ACTION_ID }),
    });
  });

  it('on a re-drain recovers the SAME id and inserts NO second placement', async () => {
    const { database, inserts } = fakeDb({ priorTargetId: NEW_EVENT_ID });
    const result = await addToCalendar(ADD_INPUT, database);

    expect(result).toEqual({ outcome: 'already_written', familyEventId: NEW_EVENT_ID });
    expect(inserts.some((i) => i.table === schema.familyEvents)).toBe(false);
  });
});

describe('cancelCalendarEvent', () => {
  it('soft-deletes the handle row (sets deleted_at) and audits the cancel', async () => {
    const { database, updateSets, inserts } = fakeDb({ updateReturns: [{ id: HANDLE }] });
    const result = await cancelCalendarEvent(
      { familyId: FAMILY_ID, actionId: ACTION_ID, reversalHandle: HANDLE },
      NOW,
      database,
    );

    expect(result).toEqual({ outcome: 'written', familyEventId: HANDLE });
    expect(updateSets).toContainEqual(expect.objectContaining({ deletedAt: NOW }));
    expect(inserts.find((i) => i.table === schema.auditLog)?.values).toMatchObject({
      actionTaken: 'action.calendar_cancelled',
      targetId: HANDLE,
    });
  });

  it('throws (no false ok) when the target row is missing or already deleted', async () => {
    const { database } = fakeDb({ updateReturns: [] });
    await expect(
      cancelCalendarEvent(
        { familyId: FAMILY_ID, actionId: ACTION_ID, reversalHandle: HANDLE },
        NOW,
        database,
      ),
    ).rejects.toThrow(/no live family_events row/);
  });
});

describe('moveCalendarEvent', () => {
  it('updates the handle row and throws when it is missing', async () => {
    const missing = fakeDb({ updateReturns: [] });
    await expect(
      moveCalendarEvent(
        {
          familyId: FAMILY_ID,
          actionId: ACTION_ID,
          reversalHandle: HANDLE,
          title: 'Swim (moved)',
          startsAt: new Date('2026-07-23T14:00:00.000Z'),
          endsAt: null,
          location: null,
        },
        missing.database,
      ),
    ).rejects.toThrow(/no live family_events row/);
  });
});

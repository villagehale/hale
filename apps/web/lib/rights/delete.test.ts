import { describe, expect, it, vi } from 'vitest';
import {
  DELETION_GRACE_MS,
  runDeletionSweep,
  scheduleFamilyDeletion,
  selectFamiliesDueForDeletion,
} from './delete';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';

interface FamilyRow {
  scheduledDeletionAt: Date | null;
}

/**
 * Fakes the select(latest scheduled_deletion_at).from().where().limit() the
 * scheduler reads to stay idempotent, plus update().set().where() (the stamp) and
 * insert().values() (the audit row). Spies record the set/values payloads.
 */
function fakeDb(existing: FamilyRow | null) {
  const limit = vi.fn().mockResolvedValue(existing ? [existing] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { select, update, insert } as never,
    spies: { update, set, insert, values },
  };
}

describe('scheduleFamilyDeletion', () => {
  it('STAMPS scheduled_deletion_at at now + the grace window (does NOT hard-delete)', async () => {
    const { db, spies } = fakeDb({ scheduledDeletionAt: null });
    const now = new Date('2026-07-03T12:00:00.000Z');

    const result = await scheduleFamilyDeletion(db, {
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now,
    });

    const expected = new Date(now.getTime() + DELETION_GRACE_MS);
    expect(result.scheduledDeletionAt).toEqual(expected);
    expect(spies.set).toHaveBeenCalledWith({ scheduledDeletionAt: expected });
    // A schedule NEVER deletes rows — no delete() on the fake, and the family
    // update only stamps the marker.
    expect(spies.update).toHaveBeenCalledTimes(1);
  });

  it('writes the immutable account_deletion_scheduled audit row (rule #6)', async () => {
    const { db, spies } = fakeDb({ scheduledDeletionAt: null });
    const now = new Date('2026-07-03T12:00:00.000Z');

    await scheduleFamilyDeletion(db, { familyId: FAMILY_ID, actorUserId: ACTOR_USER_ID, now });

    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'account_deletion_scheduled',
        targetTable: 'families',
        targetId: FAMILY_ID,
      }),
    );
  });

  it('is idempotent: an already-scheduled family keeps its original date, no new stamp, no new audit row', async () => {
    const alreadyAt = new Date('2026-07-10T12:00:00.000Z');
    const { db, spies } = fakeDb({ scheduledDeletionAt: alreadyAt });
    const now = new Date('2026-07-03T12:00:00.000Z');

    const result = await scheduleFamilyDeletion(db, {
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now,
    });

    expect(result.scheduledDeletionAt).toEqual(alreadyAt);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

const DUE_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

/**
 * Fakes the select(due families).from().where() the sweep reads, then the
 * delete(families).where() it issues per due family. Records the delete calls so
 * a test proves each due family is erased exactly once.
 */
function fakeSweepDb(dueIds: string[]) {
  const deletedWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deletedWhere });

  const selectWhere = vi.fn().mockResolvedValue(dueIds.map((id) => ({ id })));
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });

  return { db: { select, delete: deleteFn } as never, spies: { deleteFn, deletedWhere } };
}

describe('selectFamiliesDueForDeletion', () => {
  it('returns the ids of families whose grace has elapsed', async () => {
    const { db } = fakeSweepDb(DUE_IDS);
    const ids = await selectFamiliesDueForDeletion(db, new Date('2026-07-10T12:00:00.000Z'));
    expect(ids).toEqual(DUE_IDS);
  });
});

describe('runDeletionSweep', () => {
  it('hard-deletes each due family exactly once (the cascade erases its data) and reports the count', async () => {
    const { db, spies } = fakeSweepDb(DUE_IDS);

    const summary = await runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'));

    expect(summary.erased).toBe(DUE_IDS.length);
    expect(spies.deleteFn).toHaveBeenCalledTimes(DUE_IDS.length);
    expect(spies.deletedWhere).toHaveBeenCalledTimes(DUE_IDS.length);
  });

  it('erases nothing when no family is past its grace window', async () => {
    const { db, spies } = fakeSweepDb([]);
    const summary = await runDeletionSweep(db, new Date());
    expect(summary.erased).toBe(0);
    expect(spies.deleteFn).not.toHaveBeenCalled();
  });
});

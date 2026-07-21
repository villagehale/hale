import { schema } from '@hale/db';
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
 * Fakes the sweep's whole DB surface: the due-families select, the per-family
 * storage enumerations (chat_attachments + child_documents, each a queue drained in
 * due-family order), and the delete(families).where() issued per due family.
 * `removeObject` records the bytes purged and — via the shared `events` log — their
 * order relative to the row deletes, so a test can prove bytes leave BEFORE the row.
 * `attachmentPaths`/`documentPaths` are per-family path lists (dueIds order); omit
 * for families that own no storage.
 */
function fakeSweepDb(
  dueIds: string[],
  opts: { attachmentPaths?: string[][]; documentPaths?: string[][]; memberIds?: string[][] } = {},
) {
  const attachmentQueue = [...(opts.attachmentPaths ?? dueIds.map(() => []))];
  const documentQueue = [...(opts.documentPaths ?? dueIds.map(() => []))];
  const memberQueue = [...(opts.memberIds ?? dueIds.map(() => []))];

  const events: string[] = [];
  const removeObject = vi.fn(async (path: string) => {
    events.push(`remove:${path}`);
  });

  const deletedWhere = vi.fn(async () => {
    events.push('delete-family');
  });
  const deletedTokensWhere = vi.fn(async () => {
    events.push('delete-tokens');
  });
  const deleteFn = vi.fn((table: unknown) => ({
    where: table === schema.pushTokens ? deletedTokensWhere : deletedWhere,
  }));

  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === schema.chatAttachments) {
        const rows = (attachmentQueue.shift() ?? []).map((storagePath) => ({ storagePath }));
        return { where: async () => rows };
      }
      if (table === schema.childDocuments) {
        const rows = (documentQueue.shift() ?? []).map((storagePath) => ({ storagePath }));
        return { where: async () => rows };
      }
      if (table === schema.familyMembers) {
        const rows = (memberQueue.shift() ?? []).map((userId) => ({ userId }));
        return { where: async () => rows };
      }
      return { where: async () => dueIds.map((id) => ({ id })) };
    },
  }));

  return {
    db: { select, delete: deleteFn } as never,
    removeObject,
    spies: { deleteFn, deletedWhere, deletedTokensWhere, events },
  };
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
    const { db, removeObject, spies } = fakeSweepDb(DUE_IDS);

    const summary = await runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'), removeObject);

    expect(summary).toEqual({ erased: DUE_IDS.length, purgedObjects: 0 });
    expect(spies.deleteFn).toHaveBeenCalledTimes(DUE_IDS.length);
    expect(spies.deletedWhere).toHaveBeenCalledTimes(DUE_IDS.length);
  });

  it('erases nothing when no family is past its grace window', async () => {
    const { db, removeObject, spies } = fakeSweepDb([]);
    const summary = await runDeletionSweep(db, new Date(), removeObject);
    expect(summary).toEqual({ erased: 0, purgedObjects: 0 });
    expect(spies.deleteFn).not.toHaveBeenCalled();
    expect(removeObject).not.toHaveBeenCalled();
  });

  it('purges every chat-attachment AND child-document object from the bucket BEFORE dropping the family row (rule #1 / PIPEDA erasure)', async () => {
    const attachmentPaths = [`chat/${FAMILY_ID}/att-1`, `chat/${FAMILY_ID}/att-2`];
    const documentPaths = [`${FAMILY_ID}/doc-1`];
    const { db, removeObject, spies } = fakeSweepDb([FAMILY_ID], {
      attachmentPaths: [attachmentPaths],
      documentPaths: [documentPaths],
    });

    const summary = await runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'), removeObject);

    // The BYTES for both prefixes actually leave the private bucket.
    expect(removeObject.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...attachmentPaths, ...documentPaths].sort(),
    );
    // …and every removal happens BEFORE the family row is deleted, so a stored object
    // can never outlive the row that points at it (crash-safe ordering).
    const deleteAt = spies.events.indexOf('delete-family');
    expect(deleteAt).toBe(3);
    expect(spies.events.slice(0, deleteAt).every((e) => e.startsWith('remove:'))).toBe(true);
    expect(summary).toEqual({ erased: 1, purgedObjects: 3 });
  });

  it('surfaces a storage failure and leaves the family row intact for the next sweep (rule #8)', async () => {
    const { db, spies } = fakeSweepDb([FAMILY_ID], {
      attachmentPaths: [[`chat/${FAMILY_ID}/att-1`]],
    });
    const boom = vi.fn(async () => {
      throw new Error('supabase remove 500');
    });

    await expect(
      runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'), boom),
    ).rejects.toThrow('supabase remove 500');
    // A failed purge must NEVER strand bytes by erasing their pointer: the family row
    // stays, and the next sweep retries the whole erase (removeObject tolerates 404).
    expect(spies.deleteFn).not.toHaveBeenCalled();
  });

  it('deletes the erased family members device push tokens (user-scoped, so the family cascade never reaches them — rule #1)', async () => {
    const { db, removeObject, spies } = fakeSweepDb([FAMILY_ID], {
      memberIds: [['user-a', 'user-b']],
    });

    const summary = await runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'), removeObject);

    expect(summary).toEqual({ erased: 1, purgedObjects: 0 });
    // The device tokens (push_tokens.user_id → users.id, NOT families.id) are removed
    // so a device address can't outlive the erased account.
    expect(spies.deletedTokensWhere).toHaveBeenCalledTimes(1);
  });

  it('issues no token delete for a family with no members (no empty delete)', async () => {
    const { db, removeObject, spies } = fakeSweepDb([FAMILY_ID]);

    await runDeletionSweep(db, new Date('2026-07-10T12:00:00.000Z'), removeObject);

    expect(spies.deletedTokensWhere).not.toHaveBeenCalled();
  });
});

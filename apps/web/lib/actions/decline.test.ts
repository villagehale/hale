import { describe, expect, it, vi } from 'vitest';
import { declineDraftedAction } from './decline.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const DECLINER = 'user_clerk_abc';

/**
 * Fakes the precondition `select(...).from(...).where(...).limit(1)` lookup AND
 * the `transaction(cb)` the decline runs (the state update + audit insert). The
 * tx records every update/insert so a test can assert the state transition and
 * the audit_log row were both written (rule #6).
 */
function fakeDb(rows: Array<{ id: string; familyId: string; userVisibleState: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const updateSet = vi.fn();
  const updateValues = vi.fn();

  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: unknown) => {
        updateSet(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: unknown) => {
        updateValues(v);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const transaction = vi
    .fn()
    .mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

  return { db: { select, transaction } as never, updateSet, updateValues, tx };
}

describe('declineDraftedAction', () => {
  it('transitions out of drafted_for_approval and writes an audit_log row (rule #6), returns 200', async () => {
    const { db, updateSet, updateValues, tx } = fakeDb([
      { id: ACTION_ID, familyId: FAMILY_ID, userVisibleState: 'drafted_for_approval' },
    ]);

    const result = await declineDraftedAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      declinedBy: DECLINER,
    });

    expect(result.status).toBe(200);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleState: 'reverted' }),
    );
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(updateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: DECLINER,
        actionTaken: 'action.declined_by_human',
        targetTable: 'actions',
        targetId: ACTION_ID,
      }),
    );
  });

  it('returns 409 and writes nothing when the action is not awaiting approval', async () => {
    const { db, tx } = fakeDb([
      { id: ACTION_ID, familyId: FAMILY_ID, userVisibleState: 'reverted' },
    ]);

    const result = await declineDraftedAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      declinedBy: DECLINER,
    });

    expect(result.status).toBe(409);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('returns 403 and writes nothing when the action belongs to another family', async () => {
    const { db, tx } = fakeDb([
      { id: ACTION_ID, familyId: OTHER_FAMILY, userVisibleState: 'drafted_for_approval' },
    ]);

    const result = await declineDraftedAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      declinedBy: DECLINER,
    });

    expect(result.status).toBe(403);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('returns 404 and writes nothing when no action matches the id', async () => {
    const { db, tx } = fakeDb([]);

    const result = await declineDraftedAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      declinedBy: DECLINER,
    });

    expect(result.status).toBe(404);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

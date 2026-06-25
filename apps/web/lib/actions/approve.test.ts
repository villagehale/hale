import { describe, expect, it, vi } from 'vitest';
import { type ApproveQueue, approveDraftedAction } from './approve.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const APPROVER = 'user_clerk_abc';

/** Fakes the single select(...).from(...).where(...).limit(1) chain the
 * precondition lookup runs. Returns whatever `rows` is given — no real db. */
function fakeDb(rows: Array<{ id: string; familyId: string; userVisibleState: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as never;
}

function fakeQueue(): ApproveQueue & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue('job-1') };
}

describe('approveDraftedAction', () => {
  it('enqueues actions.approved with the approver stamped, returns 202', async () => {
    const db = fakeDb([
      { id: ACTION_ID, familyId: FAMILY_ID, userVisibleState: 'drafted_for_approval' },
    ]);
    const queue = fakeQueue();

    const result = await approveDraftedAction(db, queue, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      approvedBy: APPROVER,
    });

    expect(result.status).toBe(202);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(
      'actions.approved',
      expect.objectContaining({
        action_id: ACTION_ID,
        family_id: FAMILY_ID,
        approved_by: APPROVER,
        approved_at: expect.any(String),
      }),
      { expireInSeconds: 180 },
    );
    const payload = queue.send.mock.calls[0]?.[1];
    expect(payload).toBeDefined();
    expect(Number.isNaN(Date.parse(payload?.approved_at ?? ''))).toBe(false);
  });

  it('returns 409 and does NOT enqueue when the action is not awaiting approval', async () => {
    const db = fakeDb([{ id: ACTION_ID, familyId: FAMILY_ID, userVisibleState: 'autonomous' }]);
    const queue = fakeQueue();

    const result = await approveDraftedAction(db, queue, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      approvedBy: APPROVER,
    });

    expect(result.status).toBe(409);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('returns 403 and does NOT enqueue when the action belongs to another family', async () => {
    const db = fakeDb([
      { id: ACTION_ID, familyId: OTHER_FAMILY, userVisibleState: 'drafted_for_approval' },
    ]);
    const queue = fakeQueue();

    const result = await approveDraftedAction(db, queue, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      approvedBy: APPROVER,
    });

    expect(result.status).toBe(403);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('returns 404 and does NOT enqueue when no action matches the id', async () => {
    const db = fakeDb([]);
    const queue = fakeQueue();

    const result = await approveDraftedAction(db, queue, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      approvedBy: APPROVER,
    });

    expect(result.status).toBe(404);
    expect(queue.send).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { UNDO_WINDOW_HOURS, reverseExecutedCalendarAction } from './reverse-calendar.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const FAMILY_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const REVERTER = 'user_clerk_abc';
const NOW = new Date('2026-07-20T12:00:00.000Z');

type ActionRow = {
  id: string;
  familyId: string;
  actionType: string;
  userVisibleState: string;
  executedAt: Date | null;
  executorResult: Record<string, unknown> | null;
};

/**
 * Fakes the action lookup + the reversal transaction (the family_events soft-delete,
 * the action state flip, and the two audit inserts). Captures every update's `set`
 * payload and every insert's `values` so a test can assert the placement was
 * soft-deleted AND the origin action flipped AND both audit rows were written in the
 * SAME transaction (rule #6).
 */
function fakeDb(row: ActionRow | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const sets: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];

  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        sets.push(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const transaction = vi.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

  return { db: { select, transaction } as never, sets, inserts, transaction };
}

function executedAdd(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: ACTION_ID,
    familyId: FAMILY_ID,
    actionType: 'calendar_add',
    userVisibleState: 'autonomous',
    executedAt: new Date('2026-07-20T09:00:00.000Z'), // 3h before NOW → inside window
    executorResult: { kind: 'calendar_placed', reversalHandle: FAMILY_EVENT_ID },
    ...overrides,
  };
}

describe('reverseExecutedCalendarAction — the UNDO primitive', () => {
  it('soft-deletes the placement AND flips the action to reverted/undone_by_human + two audit rows', async () => {
    const { db, sets, inserts } = fakeDb(executedAdd());

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });

    expect(result).toEqual({ status: 200, familyEventId: FAMILY_EVENT_ID });

    // The placement soft-delete: an update setting deleted_at.
    expect(sets).toContainEqual(expect.objectContaining({ deletedAt: NOW }));
    // The origin-action transition: reverted + the undo reason.
    expect(sets).toContainEqual(
      expect.objectContaining({
        userVisibleState: 'reverted',
        revertedAt: NOW,
        revertedReason: 'undone_by_human',
      }),
    );
    // Both halves audited (rule #6): the cancel and the transition.
    expect(inserts).toContainEqual(
      expect.objectContaining({ actionTaken: 'action.calendar_placement_reverted', targetId: FAMILY_EVENT_ID }),
    );
    expect(inserts).toContainEqual(
      expect.objectContaining({ actionTaken: 'action.reverted_by_human', targetId: ACTION_ID }),
    );
  });

  it('rejects an action past the 24h window (measured from executed_at) without touching state', async () => {
    const stale = executedAdd({
      executedAt: new Date(NOW.getTime() - (UNDO_WINDOW_HOURS + 1) * 60 * 60 * 1000),
    });
    const { db, transaction } = fakeDb(stale);

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });

    expect(result).toEqual({ status: 409, error: 'undo_window_expired' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an action that has not executed (still awaiting approval) — no double-undo', async () => {
    const notRun = executedAdd({ userVisibleState: 'drafted_for_approval', executedAt: null });
    const { db, transaction } = fakeDb(notRun);

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });

    expect(result).toEqual({ status: 409, error: 'action_not_executed' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-reversible action type (only calendar_add is undoable)', async () => {
    const { db, transaction } = fakeDb(executedAdd({ actionType: 'calendar_move' }));

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });

    expect(result).toEqual({ status: 409, error: 'action_not_reversible' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses to reverse another family's action (403)", async () => {
    const { db, transaction } = fakeDb(executedAdd({ familyId: OTHER_FAMILY }));

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });

    expect(result).toEqual({ status: 403, error: 'action_belongs_to_another_family' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('404s a missing action', async () => {
    const { db } = fakeDb(null);
    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
    });
    expect(result).toEqual({ status: 404, error: 'action_not_found' });
  });
});

describe('reverseExecutedCalendarAction — X1 (VIL-227) loop_undo instrumentation', () => {
  it('fires loop_undo with only the actionType (no family/child detail) on a successful reversal', async () => {
    const { db } = fakeDb(executedAdd());
    const capture = vi.fn(async () => {});

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
      capture,
    });

    expect(result.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('loop_undo', REVERTER, { actionType: 'calendar_add' });
  });

  it('does NOT fire loop_undo when the reversal is refused (e.g. window expired)', async () => {
    const stale = executedAdd({
      executedAt: new Date(NOW.getTime() - (UNDO_WINDOW_HOURS + 1) * 60 * 60 * 1000),
    });
    const { db } = fakeDb(stale);
    const capture = vi.fn(async () => {});

    await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
      capture,
    });

    expect(capture).not.toHaveBeenCalled();
  });

  it('does not throw (the already-committed undo is unaffected) when capture fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb(executedAdd());
    const capture = vi.fn(async () => {
      throw new Error('posthog down');
    });

    const result = await reverseExecutedCalendarAction(db, {
      actionId: ACTION_ID,
      familyId: FAMILY_ID,
      revertedBy: REVERTER,
      now: NOW,
      capture,
    });

    expect(result.status).toBe(200);
    errorSpy.mockRestore();
  });
});

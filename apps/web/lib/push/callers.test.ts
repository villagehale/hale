import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The notify-a-family callers sit between the cron loops and sendPushToUser: they
// resolve a family's parents, re-check each parent's pref (defense in depth —
// rule #1: a false pref means zero sends even if the caller forgot to filter),
// debounce once-per-family-per-day, send, and audit. We fake the db reads/writes
// and the send/pref/debounce collaborators — no real DB, no network. Rule #1: no
// test asserts a child name or activity title in a device-bound message.

const sendPushToUserMock = vi.fn();
const pushEnabledForMock = vi.fn();
const sentPushToFamilyTodayMock = vi.fn();
const recordFamilyPushSentMock = vi.fn();

vi.mock('./send', () => ({
  sendPushToUser: (...a: unknown[]) => sendPushToUserMock(...a),
}));
vi.mock('./prefs', () => ({
  pushEnabledFor: (...a: unknown[]) => pushEnabledForMock(...a),
  sentPushToFamilyToday: (...a: unknown[]) => sentPushToFamilyTodayMock(...a),
  recordFamilyPushSent: (...a: unknown[]) => recordFamilyPushSentMock(...a),
}));

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

interface Capture {
  audit: unknown[];
}
let capture: Capture;

/** Fake db: the families row carries the coarse area; family_members→users
 * returns `parents`; audit_log inserts are captured. `area` null models a family
 * with no coarse area. */
function fakeDb(
  parents: Array<{ userId: string }>,
  cap: Capture,
  area: string | null = 'Toronto',
): unknown {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.families) {
          return { where: () => ({ limit: async () => (area === null ? [] : [{ areaCoarse: area }]) }) };
        }
        if (table === schema.familyMembers) {
          return { innerJoin: () => ({ where: async () => parents }) };
        }
        throw new Error('unexpected select');
      },
    }),
    insert: (table: unknown) => ({
      values: async (row: unknown) => {
        if (table === schema.auditLog) cap.audit.push(row);
      },
    }),
  };
}

beforeEach(() => {
  capture = { audit: [] };
  sendPushToUserMock.mockReset().mockResolvedValue({ status: 'sent', delivered: 1, pruned: 0 });
  pushEnabledForMock.mockReset().mockResolvedValue(true);
  sentPushToFamilyTodayMock.mockReset().mockResolvedValue(false);
  recordFamilyPushSentMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifyFamilyNewPicks', () => {
  it('sends to every enabled parent, records the debounce ledger, and audits each send', async () => {
    const db = fakeDb([{ userId: 'u1' }, { userId: 'u2' }], capture);
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 3, db as never);

    expect(result).toEqual({ status: 'sent', notified: 2 });
    expect(sendPushToUserMock).toHaveBeenCalledTimes(2);
    // The ledger is written ONCE per family, not once per parent.
    expect(recordFamilyPushSentMock).toHaveBeenCalledTimes(1);
    expect(recordFamilyPushSentMock).toHaveBeenCalledWith(db, FAMILY_ID, 'new_picks');
    // One audit_log row per send, category-only (rule #6): kind, never free text.
    expect(capture.audit).toHaveLength(2);
    expect(capture.audit[0]).toMatchObject({
      familyId: FAMILY_ID,
      actor: 'system',
      actionTaken: 'push_sent',
      targetId: 'u1',
      after: { kind: 'new_picks' },
    });
  });

  it('carries a coarse count + area, never a child name or activity title (rule #1)', async () => {
    const db = fakeDb([{ userId: 'u1' }], capture);
    const { notifyFamilyNewPicks } = await import('./callers');

    await notifyFamilyNewPicks(FAMILY_ID, 3, db as never);

    const [, message] = sendPushToUserMock.mock.calls[0] as [string, { title: string; body: string }];
    expect(message.title).toBe('Your village has new picks');
    expect(message.body).toBe('3 new things near Toronto');
  });

  it('sends nothing when the family has no coarse area (nowhere to name — rule #1)', async () => {
    const db = fakeDb([{ userId: 'u1' }], capture, null);
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 3, db as never);

    expect(result).toEqual({ status: 'no_area' });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
    expect(capture.audit).toEqual([]);
  });

  it('skips a parent whose new_picks pref is off (defense in depth — rule #1)', async () => {
    const db = fakeDb([{ userId: 'u1' }, { userId: 'u2' }], capture);
    pushEnabledForMock.mockImplementation(async (userId: string) => userId === 'u2');
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 1, db as never);

    expect(result).toEqual({ status: 'sent', notified: 1 });
    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
    expect(sendPushToUserMock).toHaveBeenCalledWith('u2', expect.anything(), db);
    expect(capture.audit).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({ targetId: 'u2' });
  });

  it('does NOTHING when the family already got a new_picks push today (debounce)', async () => {
    sentPushToFamilyTodayMock.mockResolvedValue(true);
    const db = fakeDb([{ userId: 'u1' }], capture);
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 5, db as never);

    expect(result).toEqual({ status: 'debounced' });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
    expect(recordFamilyPushSentMock).not.toHaveBeenCalled();
    expect(capture.audit).toEqual([]);
  });

  it('never audits or ledgers a send that did not happen — flag off (rule #6)', async () => {
    sendPushToUserMock.mockResolvedValue({ status: 'disabled' });
    const db = fakeDb([{ userId: 'u1' }, { userId: 'u2' }], capture);
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 2, db as never);

    expect(result).toEqual({ status: 'sent', notified: 0 });
    expect(capture.audit).toEqual([]);
    expect(recordFamilyPushSentMock).not.toHaveBeenCalled();
  });

  it('audits and counts only the parents whose send actually happened (mixed no_tokens)', async () => {
    sendPushToUserMock.mockImplementation(async (userId: string) =>
      userId === 'u2' ? { status: 'sent', delivered: 1, pruned: 0 } : { status: 'no_tokens' },
    );
    const db = fakeDb([{ userId: 'u1' }, { userId: 'u2' }], capture);
    const { notifyFamilyNewPicks } = await import('./callers');

    const result = await notifyFamilyNewPicks(FAMILY_ID, 2, db as never);

    expect(result).toEqual({ status: 'sent', notified: 1 });
    expect(capture.audit).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({ targetId: 'u2' });
    expect(recordFamilyPushSentMock).toHaveBeenCalledTimes(1);
  });
});

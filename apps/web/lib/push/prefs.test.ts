import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  loadPushPrefsView,
  pushEnabledFor,
  recordFamilyPushSent,
  sentPushToFamilyToday,
  startOfTorontoDay,
} from './prefs';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-17T13:00:00Z'); // 9am Toronto

/** Fakes the notification_prefs read: returns the given row (or none → defaults). */
function fakePrefsDb(row: { pushNewPicks: boolean; pushHealthReminders: boolean } | null) {
  const select = vi.fn().mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === schema.notificationPrefs) {
        return { where: () => ({ limit: async () => (row ? [row] : []) }) };
      }
      throw new Error('unexpected select target');
    },
  }));
  return { select } as never;
}

describe('loadPushPrefsView', () => {
  it('returns both push streams ON when there is no prefs row (never-touched default)', async () => {
    const view = await loadPushPrefsView(USER_ID, fakePrefsDb(null));
    expect(view).toEqual({ pushNewPicks: true, pushHealthReminders: true });
  });

  it('reflects the stored row when one exists', async () => {
    const view = await loadPushPrefsView(
      USER_ID,
      fakePrefsDb({ pushNewPicks: false, pushHealthReminders: true }),
    );
    expect(view).toEqual({ pushNewPicks: false, pushHealthReminders: true });
  });
});

describe('pushEnabledFor', () => {
  it('is true for new_picks when the stored row has it on', async () => {
    const db = fakePrefsDb({ pushNewPicks: true, pushHealthReminders: false });
    expect(await pushEnabledFor(USER_ID, 'new_picks', db)).toBe(true);
  });

  it('is false for health_reminder when the stored row has it off', async () => {
    const db = fakePrefsDb({ pushNewPicks: true, pushHealthReminders: false });
    expect(await pushEnabledFor(USER_ID, 'health_reminder', db)).toBe(false);
  });

  it('defaults to true when there is no row at all', async () => {
    const db = fakePrefsDb(null);
    expect(await pushEnabledFor(USER_ID, 'new_picks', db)).toBe(true);
    expect(await pushEnabledFor(USER_ID, 'health_reminder', db)).toBe(true);
  });
});

describe('sentPushToFamilyToday (once-per-family-per-day debounce)', () => {
  it('is true when a push_sends row for this family+kind exists since the start of the Toronto day', async () => {
    const captured: { where: unknown } = { where: undefined };
    const select = vi.fn().mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === schema.pushSends) {
          return {
            where: (w: unknown) => {
              captured.where = w;
              return { limit: async () => [{ id: 'ps-1' }] };
            },
          };
        }
        throw new Error('unexpected select target');
      },
    }));
    const db = { select } as never;

    expect(await sentPushToFamilyToday(db, FAMILY_ID, 'new_picks', NOW)).toBe(true);
    // The guard must actually filter (not a bare select) — a where clause was built.
    expect(captured.where).toBeTruthy();
  });

  it('is false when no push_sends row exists today', async () => {
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }));
    const db = { select } as never;
    expect(await sentPushToFamilyToday(db, FAMILY_ID, 'health_reminder', NOW)).toBe(false);
  });

  it('anchors the day window to Toronto local midnight across the DST boundary', () => {
    // The debounce window boundary must be the LOCAL midnight, resolving EST/EDT —
    // a hardcoded offset would be wrong for half the year. Spec-derived: Jan 17
    // midnight Toronto (EST, -05:00) is 05:00Z; Jun 17 midnight Toronto (EDT,
    // -04:00) is 04:00Z.
    expect(startOfTorontoDay(new Date('2026-01-17T13:00:00Z')).toISOString()).toBe(
      '2026-01-17T05:00:00.000Z',
    );
    expect(startOfTorontoDay(new Date('2026-06-17T13:00:00Z')).toISOString()).toBe(
      '2026-06-17T04:00:00.000Z',
    );
  });
});

describe('recordFamilyPushSent', () => {
  it('inserts a push_sends ledger row for the family+kind (no child content, rule #1)', async () => {
    const rows: unknown[] = [];
    const insert = vi.fn().mockImplementation((table: unknown) => {
      if (table === schema.pushSends) {
        return { values: async (row: unknown) => rows.push(row) };
      }
      throw new Error('unexpected insert target');
    });
    const db = { insert } as never;

    await recordFamilyPushSent(db, FAMILY_ID, 'new_picks');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ familyId: FAMILY_ID, kind: 'new_picks' });
  });
});

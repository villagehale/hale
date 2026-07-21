import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_PREFS,
  type LoopPrefUpdate,
  type LoopPrefsView,
  categoryEnabled,
  deliverableNow,
  isValidLoopPrefUpdate,
  isWeeklyPlanMoment,
  isWithinQuietHours,
  loadLoopPrefsView,
  loopChildName,
  renderChildName,
  resolveChildNameLevel,
  writeLoopPref,
} from './prefs';

/**
 * VIL-216 · A5 loop-prefs enforcement. Deterministic (no LLM), so plain Vitest —
 * a hand-rolled fake DB (mirroring push/prefs.test.ts) and injected clocks. Every
 * expected instant is derived from the spec (the local wall-clock + the zone's
 * UTC offset), never copied from output.
 */

function fakeLoopDb(row: Record<string, unknown> | null) {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.loopPrefs) throw new Error('unexpected table');
        return { where: () => ({ limit: async () => (row ? [row] : []) }) };
      },
    }),
  } as never;
}

const NOW = new Date('2026-06-01T12:00:00Z');
// deriveStage boundary is 156 months (13y). now = 2026-06-01.
const TEEN_DOB = '2012-01-01'; // ~14.4y → 'teenager'
const CHILD_DOB = '2021-01-01'; // ~5.4y → 'child'

describe('child-name level composes with the teen age gate (rule #1)', () => {
  it('forces a 13+ child to generic regardless of the parent preference', () => {
    // The load-bearing composition: a parent who chose 'first_name' still gets
    // 'generic' for a teen — the age gate can only make it MORE private.
    expect(resolveChildNameLevel(TEEN_DOB, 'first_name', NOW)).toBe('generic');
    expect(resolveChildNameLevel(TEEN_DOB, 'relation', NOW)).toBe('generic');
  });

  it("a template emitting a teen's first name FAILS — loopChildName never leaks it", () => {
    const teen = { name: 'Maya', gender: 'girl', dateOfBirth: TEEN_DOB };
    const rendered = loopChildName(teen, 'first_name', NOW);
    expect(rendered).not.toBe('Maya');
    expect(rendered).toBe('your kid');
  });

  it('a first name under generic FAILS the renderer (never emits the name)', () => {
    expect(renderChildName({ name: 'Maya', gender: 'girl' }, 'generic')).not.toBe('Maya');
  });

  it('under 13, the parent preference is honored (name / relation / generic)', () => {
    expect(resolveChildNameLevel(CHILD_DOB, 'first_name', NOW)).toBe('first_name');
    expect(loopChildName({ name: 'Maya', gender: 'girl', dateOfBirth: CHILD_DOB }, 'first_name', NOW)).toBe(
      'Maya',
    );
    expect(loopChildName({ name: 'Sam', gender: 'boy', dateOfBirth: CHILD_DOB }, 'relation', NOW)).toBe(
      'your son',
    );
    expect(loopChildName({ name: 'Ari', gender: 'nonbinary', dateOfBirth: CHILD_DOB }, 'relation', NOW)).toBe(
      'your child',
    );
    expect(loopChildName({ name: 'Ari', gender: 'unspecified', dateOfBirth: CHILD_DOB }, 'generic', NOW)).toBe(
      'your kid',
    );
  });
});

describe('quiet hours are wall-clock in the parent timezone, DST-safe', () => {
  const TZ = 'America/Toronto';
  const START = '21:30:00';
  const END = '07:30:00';

  it('holds the same 22:00-local verdict across the DST boundary (EST and EDT)', () => {
    // 22:00 local is inside 21:30-07:30 in BOTH seasons despite different UTC offsets.
    // Winter EST (UTC-5): 22:00 local Jan 14 = 03:00Z Jan 15.
    expect(isWithinQuietHours(new Date('2026-01-15T03:00:00Z'), TZ, START, END)).toBe(true);
    // Summer EDT (UTC-4): 22:00 local Jul 14 = 02:00Z Jul 15.
    expect(isWithinQuietHours(new Date('2026-07-15T02:00:00Z'), TZ, START, END)).toBe(true);
  });

  it('noon local is outside the window in both seasons', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T17:00:00Z'), TZ, START, END)).toBe(false); // 12:00 EST
    expect(isWithinQuietHours(new Date('2026-07-15T16:00:00Z'), TZ, START, END)).toBe(false); // 12:00 EDT
  });

  it('is start-inclusive and end-exclusive at the window edges', () => {
    // 21:30 local (start) = inside; 07:30 local (end) = outside. Winter EST.
    expect(isWithinQuietHours(new Date('2026-01-15T02:30:00Z'), TZ, START, END)).toBe(true); // 21:30 Jan 14
    expect(isWithinQuietHours(new Date('2026-01-15T12:30:00Z'), TZ, START, END)).toBe(false); // 07:30
  });

  it('a start==end window means "no quiet hours" (deliver anytime)', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T03:00:00Z'), TZ, '09:00:00', '09:00:00')).toBe(false);
  });
});

describe('deliverableNow composes quiet hours with the urgent-bypass toggle', () => {
  const view: LoopPrefsView = { ...DEFAULT_LOOP_PREFS };
  const TZ = 'America/Toronto';
  const IN_QUIET = new Date('2026-01-15T03:00:00Z'); // 22:00 EST
  const OUT_QUIET = new Date('2026-01-15T17:00:00Z'); // 12:00 EST

  it('defers a normal message inside quiet hours', () => {
    expect(deliverableNow(view, IN_QUIET, TZ, false)).toBe(false);
  });
  it('lets a time-sensitive message cross when bypass is on (default)', () => {
    expect(deliverableNow(view, IN_QUIET, TZ, true)).toBe(true);
  });
  it('holds a time-sensitive message when the parent turned bypass off', () => {
    expect(deliverableNow({ ...view, urgentBypassQuietHours: false }, IN_QUIET, TZ, true)).toBe(false);
  });
  it('delivers anything outside quiet hours', () => {
    expect(deliverableNow(view, OUT_QUIET, TZ, false)).toBe(true);
  });
});

describe('weekly-plan send moment: Sunday 19:30 local for each parent, DST-correct', () => {
  const view: LoopPrefsView = { ...DEFAULT_LOOP_PREFS }; // send 19:30
  const WEEK_START_MON = 1; // Monday-start week → Sunday send

  // 2026-01-18 and 2026-07-19 are both Sundays (winter EST/PST, summer EDT/PDT).
  it('matches each parent at their own local Sunday 19:30 in winter', () => {
    // Toronto EST (UTC-5): Sun 19:30 local = Mon 00:30Z.
    expect(isWeeklyPlanMoment(view, new Date('2026-01-19T00:30:00Z'), 'America/Toronto', WEEK_START_MON)).toBe(true);
    // Vancouver PST (UTC-8): Sun 19:30 local = Mon 03:30Z.
    expect(isWeeklyPlanMoment(view, new Date('2026-01-19T03:30:00Z'), 'America/Vancouver', WEEK_START_MON)).toBe(true);
  });

  it('matches each parent at their own local Sunday 19:30 in summer (DST)', () => {
    // Toronto EDT (UTC-4): Sun 19:30 local = Sun 23:30Z.
    expect(isWeeklyPlanMoment(view, new Date('2026-07-19T23:30:00Z'), 'America/Toronto', WEEK_START_MON)).toBe(true);
    // Vancouver PDT (UTC-7): Sun 19:30 local = Mon 02:30Z.
    expect(isWeeklyPlanMoment(view, new Date('2026-07-20T02:30:00Z'), 'America/Vancouver', WEEK_START_MON)).toBe(true);
  });

  it('does not match the same UTC instant for a parent in a different zone', () => {
    // At Toronto's Sun-19:30 instant, the Vancouver parent is at 16:30 (not due).
    expect(isWeeklyPlanMoment(view, new Date('2026-01-19T00:30:00Z'), 'America/Vancouver', WEEK_START_MON)).toBe(false);
  });

  it('sends the evening before the week starts — Saturday for a Sunday-start week', () => {
    // weekStartDay=0 (Sun) → send Saturday. 2026-01-17 is a Saturday.
    expect(isWeeklyPlanMoment(view, new Date('2026-01-18T00:30:00Z'), 'America/Toronto', 0)).toBe(true); // Sat 19:30 EST
  });
});

describe('loadLoopPrefsView + categoryEnabled', () => {
  it('returns the documented default when no row exists', async () => {
    await expect(loadLoopPrefsView('u1', fakeLoopDb(null))).resolves.toEqual(DEFAULT_LOOP_PREFS);
  });

  it('returns the persisted row when present', async () => {
    const row = {
      ...DEFAULT_LOOP_PREFS,
      loopChannel: 'sms',
      catReminder: false,
      childNameLevel: 'first_name',
    };
    await expect(loadLoopPrefsView('u1', fakeLoopDb(row))).resolves.toEqual(row);
  });

  it('maps each loop category to its persisted flag', () => {
    const view: LoopPrefsView = { ...DEFAULT_LOOP_PREFS, catReminder: false, catAlert: false };
    expect(categoryEnabled(view, 'weekly_plan')).toBe(true);
    expect(categoryEnabled(view, 'reminder')).toBe(false);
    expect(categoryEnabled(view, 'approval')).toBe(true);
    expect(categoryEnabled(view, 'alert')).toBe(false);
  });
});

describe('isValidLoopPrefUpdate rejects malformed untrusted input', () => {
  it('accepts well-formed values', () => {
    expect(isValidLoopPrefUpdate({ field: 'loopChannel', value: 'sms' })).toBe(true);
    expect(isValidLoopPrefUpdate({ field: 'childNameLevel', value: 'relation' })).toBe(true);
    expect(isValidLoopPrefUpdate({ field: 'catReminder', value: false })).toBe(true);
    expect(isValidLoopPrefUpdate({ field: 'quietHoursStart', value: '21:30' })).toBe(true);
    expect(isValidLoopPrefUpdate({ field: 'weeklyPlanSendTime', value: '07:00:00' })).toBe(true);
  });

  it('rejects out-of-set enums and malformed times', () => {
    expect(isValidLoopPrefUpdate({ field: 'loopChannel', value: 'carrier_pigeon' as never })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'childNameLevel', value: 'full_name' as never })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'quietHoursEnd', value: '25:00' })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'quietHoursEnd', value: '7:5' })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'weeklyPlanSendTime', value: 'noon' })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'catAlert', value: 'yes' as never })).toBe(false);
  });

  it('rejects a non-writable field (no reaching userId / timestamps)', () => {
    expect(isValidLoopPrefUpdate({ field: 'userId' as never, value: true })).toBe(false);
    expect(isValidLoopPrefUpdate({ field: 'updatedAt' as never, value: 'now' as never })).toBe(false);
  });
});

describe('writeLoopPref upserts and writes an audit row in one transaction', () => {
  function fakeTxDb() {
    const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
    const capture = (table: unknown) => (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      // Awaitable (for the direct audit insert) AND chainable (for the upsert).
      return Object.assign(Promise.resolve(), {
        onConflictDoUpdate: (_: unknown) => Promise.resolve(),
      });
    };
    const tx = { insert: (table: unknown) => ({ values: capture(table) }) };
    const database = { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as never;
    return { database, inserts };
  }

  it('records the change to loop_prefs and an audit_log row with the new value', async () => {
    const { database, inserts } = fakeTxDb();
    await writeLoopPref(database, 'user-1', 'family-9', { field: 'loopChannel', value: 'sms' });

    const prefInsert = inserts.find((i) => i.table === schema.loopPrefs);
    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect(prefInsert?.values).toEqual({ userId: 'user-1', loopChannel: 'sms' });
    expect(auditInsert?.values).toEqual({
      familyId: 'family-9',
      actor: 'user-1',
      actionTaken: 'notification_pref_updated',
      targetTable: 'loop_prefs',
      targetId: 'user-1',
      after: { loopChannel: 'sms' },
    });
  });

  it("normalizes a bare 'HH:MM' to the 'HH:MM:SS' the time column round-trips", async () => {
    const { database, inserts } = fakeTxDb();
    await writeLoopPref(database, 'user-1', 'family-9', { field: 'quietHoursStart', value: '22:00' });
    const auditInsert = inserts.find((i) => i.table === schema.auditLog);
    expect((auditInsert?.values as { after: Record<string, unknown> }).after).toEqual({
      quietHoursStart: '22:00:00',
    });
  });
});

// Sanity: the union stays exhaustive over the writable fields.
const _sample: LoopPrefUpdate[] = [
  { field: 'loopChannel', value: 'email' },
  { field: 'urgentBypassQuietHours', value: true },
  { field: 'weeklyPlanSendTime', value: '19:30' },
  { field: 'childNameLevel', value: 'generic' },
];
void _sample;

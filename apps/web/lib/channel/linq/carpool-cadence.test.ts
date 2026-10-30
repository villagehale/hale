import { describe, expect, it } from 'vitest';
import {
  type CarpoolPlanView,
  carpoolReminderFireAt,
  decideCarpoolReminder,
  decideCarpoolTurn,
  localMinutesIn,
} from './carpool-cadence';

const TZ = 'America/Toronto';
/** Saturday 10 Oct 2026, 8:00 a.m. Toronto. */
const PICKUP = new Date('2026-10-10T12:00:00.000Z');
/** Friday 9 Oct 2026, 18:00 Toronto — inside the night-before window. */
const FRIDAY_EVENING = new Date('2026-10-09T22:00:00.000Z');
/** Friday 9 Oct 2026, 22:15 Toronto — quiet hours (default 21:30 start). */
const FRIDAY_LATE = new Date('2026-10-10T02:15:00.000Z');
/** Saturday 10 Oct 2026, 7:05 Toronto — quiet over, pickup at 8:00 still ahead. */
const SATURDAY_DAWN = new Date('2026-10-10T11:05:00.000Z');
/** Friday 9 Oct 2026, 16:00 Toronto — before the window. */
const FRIDAY_AFTERNOON = new Date('2026-10-09T20:00:00.000Z');

function assigned(overrides: Partial<CarpoolPlanView> = {}): CarpoolPlanView {
  return {
    status: 'assigned',
    driverName: 'Maya',
    pickupAt: PICKUP,
    askedForDriverAt: null,
    reminderStatus: 'pending',
    reminderFireAt: carpoolReminderFireAt(PICKUP, TZ),
    ...overrides,
  };
}

describe('decideCarpoolTurn', () => {
  it('asks once when the group has a plan and no driver', () => {
    expect(
      decideCarpoolTurn({
        intent: 'plan_needs_driver',
        confidence: 'high',
        plan: {
          status: 'open',
          driverName: null,
          pickupAt: PICKUP,
          askedForDriverAt: null,
          reminderStatus: 'unscheduled',
          reminderFireAt: null,
        },
        addressed: false,
      }),
    ).toEqual({ speak: 'ask_driver' });
  });

  it('does not ask a second time', () => {
    expect(
      decideCarpoolTurn({
        intent: 'plan_needs_driver',
        confidence: 'high',
        plan: {
          status: 'open',
          driverName: null,
          pickupAt: PICKUP,
          askedForDriverAt: FRIDAY_AFTERNOON,
          reminderStatus: 'unscheduled',
          reminderFireAt: null,
        },
        addressed: false,
      }),
    ).toEqual({ speak: 'silent', reason: 'already_asked' });
  });

  it('stays quiet on banter', () => {
    expect(
      decideCarpoolTurn({
        intent: 'chatter',
        confidence: 'high',
        plan: assigned(),
        addressed: false,
      }),
    ).toEqual({ speak: 'silent', reason: 'chatter' });
  });

  it('does not speak when someone claims or swaps — state updates elsewhere', () => {
    expect(
      decideCarpoolTurn({
        intent: 'driver_claim',
        confidence: 'high',
        plan: assigned({ driverName: null, status: 'open' }),
        addressed: false,
      }),
    ).toEqual({ speak: 'silent', reason: 'chatter' });
    expect(
      decideCarpoolTurn({
        intent: 'driver_swap',
        confidence: 'high',
        plan: assigned(),
        addressed: false,
      }),
    ).toEqual({ speak: 'silent', reason: 'has_driver' });
  });

  it('does not invent a turn from a low-confidence read', () => {
    expect(
      decideCarpoolTurn({
        intent: 'plan_needs_driver',
        confidence: 'low',
        plan: {
          status: 'open',
          driverName: null,
          pickupAt: PICKUP,
          askedForDriverAt: null,
          reminderStatus: 'unscheduled',
          reminderFireAt: null,
        },
        addressed: false,
      }),
    ).toEqual({ speak: 'silent', reason: 'unclear' });
  });
});

describe('decideCarpoolReminder', () => {
  it('fires inside the night-before window when a driver is set', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned(),
        now: FRIDAY_EVENING,
        localMinutes: localMinutesIn(FRIDAY_EVENING, TZ),
        quiet: false,
        quietStartMin: 21 * 60,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'fire' });
  });

  it('holds during quiet hours with default prefs (21:30 quiet start)', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned(),
        now: FRIDAY_LATE,
        localMinutes: localMinutesIn(FRIDAY_LATE, TZ),
        quiet: true,
        quietStartMin: 21 * 60 + 30,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'hold', reason: 'quiet_hours' });
  });

  it('catches up after quiet hours end when pickup is still ahead', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned(),
        now: SATURDAY_DAWN,
        localMinutes: localMinutesIn(SATURDAY_DAWN, TZ),
        quiet: false,
        quietStartMin: 21 * 60 + 30,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'fire' });
  });

  it('drops once pickup has passed', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned(),
        now: new Date(PICKUP.getTime() + 60_000),
        localMinutes: localMinutesIn(new Date(PICKUP.getTime() + 60_000), TZ),
        quiet: false,
        quietStartMin: 21 * 60 + 30,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'skip', reason: 'window_closed' });
  });

  it('still holds a cancelled plan as cancelled during quiet hours', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned({ status: 'cancelled', reminderStatus: 'skipped_cancelled' }),
        now: FRIDAY_LATE,
        localMinutes: localMinutesIn(FRIDAY_LATE, TZ),
        quiet: true,
        quietStartMin: 21 * 60 + 30,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'skip', reason: 'cancelled' });
  });

  it('sends nothing after the plan is cancelled', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned({ status: 'cancelled', reminderStatus: 'skipped_cancelled' }),
        now: FRIDAY_EVENING,
        localMinutes: localMinutesIn(FRIDAY_EVENING, TZ),
        quiet: false,
        quietStartMin: 21 * 60,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'skip', reason: 'cancelled' });
  });

  it('sends nothing when there is still no driver', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned({ driverName: null, status: 'open', reminderStatus: 'pending' }),
        now: FRIDAY_EVENING,
        localMinutes: localMinutesIn(FRIDAY_EVENING, TZ),
        quiet: false,
        quietStartMin: 21 * 60,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'skip', reason: 'no_driver' });
  });

  it('waits before the evening window', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned(),
        now: FRIDAY_AFTERNOON,
        localMinutes: localMinutesIn(FRIDAY_AFTERNOON, TZ),
        quiet: false,
        quietStartMin: 21 * 60,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'wait' });
  });

  it('does not fire a reminder that already left', () => {
    expect(
      decideCarpoolReminder({
        plan: assigned({ reminderStatus: 'sent' }),
        now: FRIDAY_EVENING,
        localMinutes: localMinutesIn(FRIDAY_EVENING, TZ),
        quiet: false,
        quietStartMin: 21 * 60,
        timeZone: TZ,
      }),
    ).toEqual({ action: 'skip', reason: 'already_sent' });
  });
});

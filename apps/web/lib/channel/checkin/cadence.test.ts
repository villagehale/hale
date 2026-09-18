import { describe, expect, it } from 'vitest';
import {
  type CheckInState,
  DEFAULT_CHECK_IN_STATE,
  askStillStanding,
  decideCheckIn,
  isEveningCheckInSlot,
  localDateKey,
} from './cadence';

const TZ = 'America/Toronto';
/** 20:17 local on a Monday in July (EDT, UTC-4) — the tick the nudge cron actually
 * lands the question on. */
const EVENING = new Date('2026-07-06T00:17:00.000Z');

function state(overrides: Partial<CheckInState> = {}): CheckInState {
  return { ...DEFAULT_CHECK_IN_STATE, ...overrides };
}

/** The evening slot, N days after the first one. */
function eveningPlus(days: number): Date {
  return new Date(EVENING.getTime() + days * 24 * 3_600_000);
}

describe('the evening slot', () => {
  it('is the 20:00 local hour, not a UTC hour', () => {
    expect(isEveningCheckInSlot(EVENING, TZ)).toBe(true);
    expect(localDateKey(EVENING, TZ)).toBe('2026-07-05');
    // The same instant is 02:17 the next morning in Paris, and 17:17 in Vancouver.
    expect(isEveningCheckInSlot(EVENING, 'Europe/Paris')).toBe(false);
    expect(isEveningCheckInSlot(EVENING, 'America/Vancouver')).toBe(false);
    // Vancouver's own 20:00 is three hours later.
    expect(isEveningCheckInSlot(eveningPlus(0.125), 'America/Vancouver')).toBe(true);
  });

  it('refuses 21:00, which is the quiet-hours floor and the hour the clamp exists for', () => {
    expect(isEveningCheckInSlot(new Date('2026-07-06T01:17:00.000Z'), TZ)).toBe(false);
    expect(isEveningCheckInSlot(new Date('2026-07-05T23:17:00.000Z'), TZ)).toBe(false);
  });
});

describe('how long an unanswered ask stands', () => {
  it('stands for the rest of the evening and lapses at 08:00 the next local morning', () => {
    // 23:50 the same local night.
    expect(askStillStanding(EVENING, new Date('2026-07-06T03:50:00.000Z'), TZ)).toBe(true);
    // 00:20 — a new local day, still before the morning.
    expect(askStillStanding(EVENING, new Date('2026-07-06T04:20:00.000Z'), TZ)).toBe(true);
    // 07:59 local.
    expect(askStillStanding(EVENING, new Date('2026-07-06T11:59:00.000Z'), TZ)).toBe(true);
    // 08:01 local — the morning is a new conversation.
    expect(askStillStanding(EVENING, new Date('2026-07-06T12:01:00.000Z'), TZ)).toBe(false);
  });

  it('never stands a second time on some later pre-dawn morning', () => {
    // 02:00 local, three days on: before 08:00, but the ask is long gone.
    expect(askStillStanding(EVENING, new Date('2026-07-09T06:00:00.000Z'), TZ)).toBe(false);
  });
});

describe('the stop-answering ladder', () => {
  it('asks a household that has never been asked, and says so', () => {
    expect(decideCheckIn(state(), EVENING, TZ)).toEqual({
      kind: 'ask',
      first: true,
      silentStreak: 0,
    });
  });

  it('never asks twice in one local evening', () => {
    const asked = state({ lastAskedAt: EVENING });
    expect(decideCheckIn(asked, new Date(EVENING.getTime() + 60_000), TZ)).toEqual({
      kind: 'skip',
      reason: 'asked_today',
    });
  });

  it('honours a parent who said no, forever', () => {
    expect(decideCheckIn(state({ cadence: 'off' }), eveningPlus(400), TZ)).toEqual({
      kind: 'skip',
      reason: 'cadence_off',
    });
  });

  it('counts three silent evenings, steps down once, then waits a week and stops', () => {
    // Night 1 asked, nobody answered.
    let current = state({ lastAskedAt: EVENING, silentStreak: 0 });

    const night2 = decideCheckIn(current, eveningPlus(1), TZ);
    expect(night2).toEqual({ kind: 'ask', first: false, silentStreak: 1 });
    current = { ...current, lastAskedAt: eveningPlus(1), silentStreak: 1 };

    const night3 = decideCheckIn(current, eveningPlus(2), TZ);
    expect(night3).toEqual({ kind: 'ask', first: false, silentStreak: 2 });
    current = { ...current, lastAskedAt: eveningPlus(2), silentStreak: 2 };

    // The third lapse is the one that ends the daily rhythm.
    expect(decideCheckIn(current, eveningPlus(3), TZ)).toEqual({ kind: 'step_down' });
    // The step-down leaves `lastAskedAt` where it was — that is what makes the weekly
    // clock run from the last real ask and stops the notice counting as a fourth lapse.
    current = { ...current, cadence: 'weekly', silentStreak: 0 };

    // The six evenings after it are silent by design, not by the ladder.
    expect(decideCheckIn(current, eveningPlus(4), TZ)).toEqual({
      kind: 'skip',
      reason: 'not_due',
    });
    expect(decideCheckIn(current, eveningPlus(8), TZ)).toEqual({
      kind: 'skip',
      reason: 'not_due',
    });

    // A week after the last ask: weekly question one.
    expect(decideCheckIn(current, eveningPlus(9), TZ)).toEqual({
      kind: 'ask',
      first: false,
      silentStreak: 1,
    });
    current = { ...current, lastAskedAt: eveningPlus(9), silentStreak: 1 };

    // Weekly question two.
    expect(decideCheckIn(current, eveningPlus(16), TZ)).toEqual({
      kind: 'ask',
      first: false,
      silentStreak: 2,
    });
    current = { ...current, lastAskedAt: eveningPlus(16), silentStreak: 2 };

    // Three more lapses on weekly, and Hale goes quiet without announcing it.
    expect(decideCheckIn(current, eveningPlus(23), TZ)).toEqual({
      kind: 'dormant',
      silentStreak: 3,
    });
  });

  it('forgets the whole streak the moment a parent answers once', () => {
    const answered = state({
      cadence: 'daily',
      silentStreak: 2,
      lastAskedAt: eveningPlus(2),
      lastAnsweredAt: new Date(eveningPlus(2).getTime() + 5 * 60_000),
    });
    expect(decideCheckIn(answered, eveningPlus(3), TZ)).toEqual({
      kind: 'ask',
      first: false,
      silentStreak: 0,
    });
  });
});

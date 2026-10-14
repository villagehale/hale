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

describe('whether tonight is offered', () => {
  it('offers a household that has never been asked', () => {
    expect(decideCheckIn(state(), EVENING, TZ)).toEqual({ kind: 'ask' });
  });

  it('never offers twice in one local evening', () => {
    const asked = state({ lastAskedAt: EVENING });
    expect(decideCheckIn(asked, new Date(EVENING.getTime() + 60_000), TZ)).toEqual({
      kind: 'skip',
      reason: 'asked_today',
    });
  });

  it('honours a stored stop', () => {
    expect(decideCheckIn(state({ cadence: 'off' }), eveningPlus(400), TZ)).toEqual({
      kind: 'skip',
      reason: 'cadence_off',
    });
  });

  it('still offers after three silent evenings, and on a stored weekly cadence', () => {
    const silent = state({
      cadence: 'daily',
      silentStreak: 3,
      lastAskedAt: EVENING,
    });
    expect(decideCheckIn(silent, eveningPlus(1), TZ)).toEqual({ kind: 'ask' });
    const weekly = state({
      cadence: 'weekly',
      silentStreak: 2,
      lastAskedAt: EVENING,
    });
    expect(decideCheckIn(weekly, eveningPlus(1), TZ)).toEqual({ kind: 'ask' });
  });
});

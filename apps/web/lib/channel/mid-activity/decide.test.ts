import { describe, expect, it } from 'vitest';
import {
  cadenceFromSessionStarts,
  decideMidActivityAsk,
  midpointSession,
  preferenceFromCheckIn,
  sessionsElapsed,
} from './decide';

const WEEK = 7 * 24 * 3_600_000;

function weeklyStarts(count: number, first = Date.parse('2026-05-06T14:00:00.000Z')): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(first + i * WEEK));
}

describe('preferenceFromCheckIn', () => {
  it('treats a missing row as fewer, not the evening check-in daily default', () => {
    expect(preferenceFromCheckIn(null)).toBe('fewer');
  });

  it('maps the stored cadence, with weekly and off both asking less', () => {
    expect(preferenceFromCheckIn({ cadence: 'off' })).toBe('off');
    expect(preferenceFromCheckIn({ cadence: 'weekly' })).toBe('fewer');
    expect(preferenceFromCheckIn({ cadence: 'daily' })).toBe('regular');
  });
});

describe('cadenceFromSessionStarts', () => {
  it('calls one start, a same-day cluster, and a rare gap once', () => {
    const day = Date.parse('2026-06-01T14:00:00.000Z');
    expect(cadenceFromSessionStarts([new Date(day)])).toBe('once');
    expect(
      cadenceFromSessionStarts([
        new Date(day),
        new Date(day + 2 * 3_600_000),
        new Date(day + 4 * 3_600_000),
      ]),
    ).toBe('once');
    expect(cadenceFromSessionStarts([new Date(day), new Date(day + 21 * 24 * 3_600_000)])).toBe(
      'once',
    );
  });

  it('calls a weekly gap weekly and a twice-a-week gap often', () => {
    expect(cadenceFromSessionStarts(weeklyStarts(8))).toBe('weekly');
    const first = Date.parse('2026-05-06T14:00:00.000Z');
    const twice = Array.from({ length: 6 }, (_, i) => new Date(first + i * 3 * 24 * 3_600_000));
    expect(cadenceFromSessionStarts(twice)).toBe('often');
  });
});

describe('decideMidActivityAsk', () => {
  const now = new Date('2026-06-03T15:00:00.000Z');
  const starts = weeklyStarts(8);

  it('asks once, on the later middle session, when the parent has not asked for more', () => {
    expect(sessionsElapsed(starts, now)).toBe(5);
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'fewer',
        sessionsElapsed: 5,
        sessionsPlanned: 8,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: true, atSession: 5 });
    expect(midpointSession({ cadence: 'weekly', preference: 'fewer', sessionsPlanned: 8 })).toBe(5);
  });

  it('asks one session earlier when the parent chose the regular cadence', () => {
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'regular',
        sessionsElapsed: 4,
        sessionsPlanned: 8,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: true, atSession: 4 });
  });

  it('does not ask again, and does not catch up after the node', () => {
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'fewer',
        sessionsElapsed: 5,
        sessionsPlanned: 8,
        alreadyAsked: true,
      }),
    ).toEqual({ ask: false, reason: 'already_asked' });
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'fewer',
        sessionsElapsed: 6,
        sessionsPlanned: 8,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'past_window' });
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'fewer',
        sessionsElapsed: 4,
        sessionsPlanned: 8,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'too_soon' });
  });

  it('stays quiet when the parent turned asks off, or the series is too short or rare', () => {
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'off',
        sessionsElapsed: 5,
        sessionsPlanned: 8,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'preference_off' });
    expect(
      decideMidActivityAsk({
        cadence: 'once',
        preference: 'regular',
        sessionsElapsed: 1,
        sessionsPlanned: 1,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'too_rare' });
    expect(
      decideMidActivityAsk({
        cadence: 'weekly',
        preference: 'fewer',
        sessionsElapsed: 3,
        sessionsPlanned: 5,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'too_rare' });
  });

  it('uses one later node for an open-ended series when the parent prefers fewer', () => {
    expect(midpointSession({ cadence: 'weekly', preference: 'fewer', sessionsPlanned: null })).toBe(
      4,
    );
    expect(
      midpointSession({ cadence: 'weekly', preference: 'regular', sessionsPlanned: null }),
    ).toBe(3);
    expect(midpointSession({ cadence: 'often', preference: 'fewer', sessionsPlanned: null })).toBe(
      6,
    );
    expect(
      decideMidActivityAsk({
        cadence: 'often',
        preference: 'regular',
        sessionsElapsed: 4,
        sessionsPlanned: null,
        alreadyAsked: false,
      }),
    ).toEqual({ ask: true, atSession: 4 });
  });
});

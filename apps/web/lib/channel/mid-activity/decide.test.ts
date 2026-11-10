import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_MS,
  decideMidActivityAsk,
  firstSessionAskWindow,
  firstSessionEnd,
  preferenceFromCheckIn,
} from './decide';

const TZ = 'America/Toronto';

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

describe('firstSessionEnd', () => {
  it('takes the earliest session, its own end, or its start plus the default length', () => {
    const a = new Date('2026-06-02T14:00:00.000Z');
    const b = new Date('2026-06-09T14:00:00.000Z');
    expect(
      firstSessionEnd([
        { startsAt: b, endsAt: null },
        { startsAt: a, endsAt: new Date('2026-06-02T15:30:00.000Z') },
      ]),
    ).toEqual(new Date('2026-06-02T15:30:00.000Z'));
    expect(firstSessionEnd([{ startsAt: a, endsAt: a }])).toEqual(
      new Date(a.getTime() + DEFAULT_SESSION_MS),
    );
    expect(firstSessionEnd([])).toBeNull();
  });
});

describe('firstSessionAskWindow', () => {
  it('opens at 18:00 local the day a morning session ends, closes 08:00 next morning', () => {
    const w = firstSessionAskWindow(new Date('2026-06-02T15:00:00.000Z'), TZ); // 11:00 EDT
    expect(w.opensAt).toEqual(new Date('2026-06-02T22:00:00.000Z'));
    expect(w.closesAt).toEqual(new Date('2026-06-03T12:00:00.000Z'));
  });

  it('opens when an early-evening session ends, and moves a late one to the next evening', () => {
    const early = firstSessionAskWindow(new Date('2026-06-02T23:30:00.000Z'), TZ); // 19:30
    expect(early.opensAt).toEqual(new Date('2026-06-02T23:30:00.000Z'));
    const late = firstSessionAskWindow(new Date('2026-06-03T01:30:00.000Z'), TZ); // 21:30
    expect(late.opensAt).toEqual(new Date('2026-06-03T22:00:00.000Z'));
    expect(late.closesAt).toEqual(new Date('2026-06-04T12:00:00.000Z'));
  });
});

describe('decideMidActivityAsk', () => {
  const ended = new Date('2026-06-02T15:00:00.000Z');
  const base = { preference: 'fewer' as const, firstSessionEndedAt: ended, timeZone: TZ };

  it('asks once, the evening after the first session', () => {
    const at = new Date('2026-06-02T23:00:00.000Z');
    expect(decideMidActivityAsk({ ...base, now: at, alreadyAsked: false })).toMatchObject({
      ask: true,
    });
    expect(decideMidActivityAsk({ ...base, now: at, alreadyAsked: true })).toEqual({
      ask: false,
      reason: 'already_asked',
    });
  });

  it('waits for the evening, and does not catch up the next day', () => {
    expect(
      decideMidActivityAsk({
        ...base,
        now: new Date('2026-06-02T18:00:00.000Z'),
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'too_soon' });
    expect(
      decideMidActivityAsk({
        ...base,
        now: new Date('2026-06-03T13:00:00.000Z'),
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'past_window' });
  });

  it('stays quiet when the parent turned asks off', () => {
    expect(
      decideMidActivityAsk({
        ...base,
        preference: 'off',
        now: new Date('2026-06-02T23:00:00.000Z'),
        alreadyAsked: false,
      }),
    ).toEqual({ ask: false, reason: 'preference_off' });
  });
});

import { describe, expect, it } from 'vitest';
import { dayTimeConflict } from './day-time';

/**
 * VIL-581 · the refusal-only day/time cross-check on a booking cited to a calendar row.
 * Row: Tuesday 2026-11-03 at 09:00 in the family's own zone (Denver, UTC−7).
 */

const TZ = 'America/Denver';
const TUE_9 = new Date('2026-11-03T16:00:00Z');
const TUE_21 = new Date('2026-11-04T04:00:00Z');

describe('dayTimeConflict', () => {
  it('en: a different weekday and time conflict; the right ones do not', () => {
    expect(dayTimeConflict('Thursday 3pm swim is booked.', TUE_9, TZ, 'en')).toBe(true);
    expect(dayTimeConflict('Tuesday 9:00 swim is booked.', TUE_9, TZ, 'en')).toBe(false);
  });

  it('fr: jeudi à 15h conflicts; mardi à 9h00 does not', () => {
    expect(dayTimeConflict('Ta natation de jeudi à 15h est réservée.', TUE_9, TZ, 'fr')).toBe(true);
    expect(dayTimeConflict('Ta natation de mardi à 9h00 est réservée.', TUE_9, TZ, 'fr')).toBe(
      false,
    );
  });

  it('fr: a clock time alone is checked (positive control for the h form)', () => {
    expect(dayTimeConflict('Ta séance à 15h est réservée.', TUE_9, TZ, 'fr')).toBe(true);
    expect(dayTimeConflict('Ta séance à 9h est réservée.', TUE_9, TZ, 'fr')).toBe(false);
  });

  it('es: el jueves conflicts', () => {
    expect(
      dayTimeConflict('Tu clase de natación del jueves está reservada.', TUE_9, TZ, 'es'),
    ).toBe(true);
    expect(
      dayTimeConflict('Tu clase de natación del martes está reservada.', TUE_9, TZ, 'es'),
    ).toBe(false);
  });

  it('zh: 周四下午3点 conflicts; 周二9点 does not', () => {
    expect(dayTimeConflict('周四下午3点的游泳课已经约好了。', TUE_9, TZ, 'zh')).toBe(true);
    expect(dayTimeConflict('周二9点的游泳课已经约好了。', TUE_9, TZ, 'zh')).toBe(false);
  });

  it('short English forms are not read, so "Sam" and "sat" never match', () => {
    expect(dayTimeConflict('Sam sat down and swim is booked.', TUE_9, TZ, 'en')).toBe(false);
    // Positive control: the long form of the same day is read.
    expect(dayTimeConflict('Saturday swim is booked.', TUE_9, TZ, 'en')).toBe(true);
  });

  it('a time with no meridiem matches either half of the day', () => {
    expect(dayTimeConflict('Your 9:00 swim is booked.', TUE_21, TZ, 'en')).toBe(false);
    expect(dayTimeConflict('Your 9:00 a.m. swim is booked.', TUE_21, TZ, 'en')).toBe(true);
  });

  it('relative days are a named gap: "tomorrow" is not read', () => {
    expect(dayTimeConflict('Your swim tomorrow is booked.', TUE_9, TZ, 'en')).toBe(false);
  });

  it('D11 residual: a compound sentence whose other clause names another time is refused', () => {
    expect(
      dayTimeConflict('Registration opens at 7:00 a.m.; your swim is booked.', TUE_9, TZ, 'en'),
    ).toBe(true);
    expect(dayTimeConflict('Registration opens soon; your swim is booked.', TUE_9, TZ, 'en')).toBe(
      false,
    );
  });

  it('an unknown locale reads English weekday names only', () => {
    expect(dayTimeConflict('Jeudi, ta séance est réservée.', TUE_9, TZ, undefined)).toBe(false);
    expect(dayTimeConflict('Jeudi, ta séance est réservée.', TUE_9, TZ, 'fr')).toBe(true);
  });

  it('ar: a different weekday conflicts; the right one does not', () => {
    expect(dayTimeConflict('موعد السباحة يوم الخميس محجوز.', TUE_9, TZ, 'ar')).toBe(true);
    expect(dayTimeConflict('موعد السباحة يوم الثلاثاء محجوز.', TUE_9, TZ, 'ar')).toBe(false);
  });
});

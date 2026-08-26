import { describe, expect, it } from 'vitest';
import { WEEKDAYS, weekdayOf, weekdayViolation } from './weekday';

const TZ = 'America/Toronto';

describe('weekdayOf', () => {
  it('reads the family-local weekday of a day key', () => {
    expect(weekdayOf('2026-08-20', TZ)).toBe('thu');
    expect(weekdayOf('2026-08-22', TZ)).toBe('sat');
    expect(weekdayOf('2026-08-23', TZ)).toBe('sun');
  });

  /** Noon rather than midnight, so a spring-forward day cannot answer as the day before.
   * 2026-03-08 is the DST change in Toronto. */
  it('is not moved by a daylight-saving boundary', () => {
    expect(weekdayOf('2026-03-08', TZ)).toBe('sun');
    expect(weekdayOf('2026-11-01', TZ)).toBe('sun');
  });

  it('answers in the family time zone, not the server one', () => {
    // 2026-08-20 is a Thursday everywhere; Auckland is the zone where a UTC-midnight
    // reading would already be Friday.
    expect(weekdayOf('2026-08-20', 'Pacific/Auckland')).toBe('thu');
  });
});

describe('weekdayViolation', () => {
  /**
   * THE AUDIT INCIDENT, replayed. A parent asked for "this Thursday" on Thursday
   * 2026-08-20 and the turn said "Thursday, August twenty-second" — a Saturday.
   */
  it('refuses "Thursday" attached to a Saturday, and names both true dates', () => {
    const violation = weekdayViolation({
      date: '2026-08-22',
      weekday: 'thu',
      timeZone: TZ,
      tool: 'propose_calendar_add',
    });

    expect(violation).toContain('2026-08-22 is a Saturday');
    expect(violation).toContain('not a Thursday');
    // The other half of the correction: the date the parent probably meant.
    expect(violation).toContain('2026-08-20');
    expect(violation).toContain('propose_calendar_add');
  });

  it('passes a date and weekday that agree', () => {
    expect(
      weekdayViolation({
        date: '2026-08-20',
        weekday: 'thu',
        timeZone: TZ,
        tool: 'propose_calendar_add',
      }),
    ).toBeNull();
  });

  /** Every weekday of one real week, both directions — the positive control that makes
   * the refusals above a real constraint rather than a lucky pair. */
  it('agrees with itself on every day of a week and disagrees on every other', () => {
    const week = [
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ];
    for (const [index, date] of week.entries()) {
      const truth = WEEKDAYS[index] as (typeof WEEKDAYS)[number];
      expect(weekdayViolation({ date, weekday: truth, timeZone: TZ, tool: 't' })).toBeNull();
      for (const other of WEEKDAYS.filter((day) => day !== truth)) {
        expect(weekdayViolation({ date, weekday: other, timeZone: TZ, tool: 't' })).not.toBeNull();
      }
    }
  });

  /** The correction has to cross a month boundary correctly, or a re-ask lands the parent
   * a month out — a worse error than the one being fixed. */
  it('names the right date when the corrected day is in the previous month', () => {
    const violation = weekdayViolation({
      date: '2026-09-01',
      weekday: 'sun',
      timeZone: TZ,
      tool: 't',
    });

    expect(violation).toContain('2026-09-01 is a Tuesday');
    expect(violation).toContain('2026-08-30');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  dayKeyOf,
  formatCalendarDate,
  formatDateTime,
  formatDayHeading,
  formatLongDate,
  formatTime,
  formatWhenPhrase,
} from './datetime.js';

/**
 * The time layer's contract: a stored instant is formatted against an EXPLICIT
 * zone (never the server's), and the SAME instant reads differently in different
 * zones — proving the zone is honoured, not ignored. Calendar dates round-trip
 * their exact day in UTC. Expected strings are derived from the UTC offsets, not
 * copied from the code's output.
 */

// 2026-06-11 14:05:00 UTC. Toronto is EDT (UTC-4) → 10:05; Vancouver PDT (UTC-7)
// → 07:05; UTC → 14:05. One instant, three zones, three answers.
const SUMMER_INSTANT = '2026-06-11T14:05:00Z';
const NOW_SAME_YEAR = new Date('2026-06-12T00:00:00Z');

describe('formatTime', () => {
  it('renders HH:MM 24h in the given zone', () => {
    expect(formatTime(SUMMER_INSTANT, 'America/Toronto')).toBe('10:05');
    expect(formatTime(SUMMER_INSTANT, 'America/Vancouver')).toBe('07:05');
    expect(formatTime(SUMMER_INSTANT, 'UTC')).toBe('14:05');
  });

  it('honours DST — the same wall gap yields a different UTC offset in winter', () => {
    // 2026-01-15 14:05 UTC: Toronto is EST (UTC-5) → 09:05, not 10:05.
    expect(formatTime('2026-01-15T14:05:00Z', 'America/Toronto')).toBe('09:05');
  });
});

describe('formatDateTime', () => {
  it('renders month/day + 24h time in the given zone, no year within this year', () => {
    expect(formatDateTime(SUMMER_INSTANT, 'America/Toronto', NOW_SAME_YEAR)).toBe('Jun 11, 10:05');
    expect(formatDateTime(SUMMER_INSTANT, 'UTC', NOW_SAME_YEAR)).toBe('Jun 11, 14:05');
  });

  it('includes the year for an other-year instant', () => {
    // A 2025 draft viewed in 2026 must carry its year so it can't read as recent.
    expect(formatDateTime('2025-11-02T18:30:00Z', 'America/Toronto', NOW_SAME_YEAR)).toBe(
      'Nov 2, 2025, 13:30',
    );
  });

  it('judges "this year" in the render zone, not UTC, at the year boundary', () => {
    // 2026-01-01 02:00 UTC is 2025-12-31 21:00 in Toronto — same year as a
    // Toronto "now" of early Jan 2026? No: it is the PRIOR year locally, so the
    // year is shown. UTC-side it would (wrongly) read as 2026 and be hidden.
    const nowEarly2026 = new Date('2026-01-05T12:00:00Z');
    expect(formatDateTime('2026-01-01T02:00:00Z', 'America/Toronto', nowEarly2026)).toBe(
      'Dec 31, 2025, 21:00',
    );
  });
});

describe('formatWhenPhrase', () => {
  it('renders month/day + 12h time in the given zone', () => {
    expect(formatWhenPhrase(SUMMER_INSTANT, 'America/Toronto', NOW_SAME_YEAR)).toBe(
      'Jun 11, 10:05 a.m.',
    );
    expect(formatWhenPhrase(SUMMER_INSTANT, 'America/Vancouver', NOW_SAME_YEAR)).toBe(
      'Jun 11, 7:05 a.m.',
    );
  });

  it('includes the year for an other-year instant', () => {
    expect(formatWhenPhrase('2025-03-09T20:15:00Z', 'America/Toronto', NOW_SAME_YEAR)).toBe(
      'Mar 9, 2025, 4:15 p.m.',
    );
  });
});

describe('formatCalendarDate', () => {
  it('round-trips the typed day in UTC regardless of what a viewer zone would shift it to', () => {
    // A parent typed 2026-07-15 into <input type="date">; the client stored
    // new Date('2026-07-15').toISOString() === UTC midnight. Formatting in a
    // west-of-UTC zone would roll it back to Jul 14 — UTC keeps Jul 15.
    const storedUtcMidnight = new Date('2026-07-15').toISOString();
    expect(formatCalendarDate(storedUtcMidnight, NOW_SAME_YEAR)).toBe('Jul 15');
  });

  it('includes the year for an other-year calendar date', () => {
    const stored2025 = new Date('2025-12-24').toISOString();
    expect(formatCalendarDate(stored2025, NOW_SAME_YEAR)).toBe('Dec 24, 2025');
  });
});

describe('formatLongDate', () => {
  it('computes the weekday/date in the given zone, lower-cased', () => {
    // 2026-07-03 15:00 UTC is Friday Jul 3 2026 in Toronto.
    expect(formatLongDate(new Date('2026-07-03T15:00:00Z'), 'America/Toronto')).toEqual({
      weekday: 'friday',
      month: 'jul',
      day: '3',
      year: '2026',
    });
  });

  it('shows the LOCAL day near the UTC boundary — 11pm ET is not yet tomorrow', () => {
    // 2026-01-01 02:00 UTC is still 2025-12-31 (Wednesday) at 9pm in Toronto.
    // The server-TZ bug would show Jan 1 2026 (Thursday).
    expect(formatLongDate(new Date('2026-01-01T02:00:00Z'), 'America/Toronto')).toEqual({
      weekday: 'wednesday',
      month: 'dec',
      day: '31',
      year: '2025',
    });
  });
});

describe('dayKeyOf — a stable calendar-day key in the render zone', () => {
  it('keys by the LOCAL calendar day, so the same instant keys differently across zones', () => {
    // 2026-06-11 14:05 UTC is Jun 11 in Toronto but Jun 11 in Vancouver too; use a
    // late-evening UTC instant to expose the zone: 2026-06-12 02:00 UTC is still
    // Jun 11 (10pm) in Toronto but Jun 11 (7pm) in Vancouver — both Jun 11 — so
    // pick 2026-06-12 05:00 UTC: Jun 12 (1am) Toronto vs Jun 11 (10pm) Vancouver.
    expect(dayKeyOf('2026-06-12T05:00:00Z', 'America/Toronto')).toBe('2026-06-12');
    expect(dayKeyOf('2026-06-12T05:00:00Z', 'America/Vancouver')).toBe('2026-06-11');
  });

  it('groups two instants on the same local day under one key', () => {
    expect(dayKeyOf('2026-06-11T13:00:00Z', 'America/Toronto')).toBe(
      dayKeyOf('2026-06-11T23:00:00Z', 'America/Toronto'),
    );
  });
});

describe('formatDayHeading — the human day heading for a grouped section', () => {
  const NOW = new Date('2026-07-03T15:00:00Z');

  it('reads weekday + month + day in the render zone, no year within this year', () => {
    // 2026-06-11 14:05 UTC is Thursday Jun 11 in Toronto.
    expect(formatDayHeading('2026-06-11T14:05:00Z', 'America/Toronto', NOW)).toBe(
      'Thursday, Jun 11',
    );
  });

  it('carries the year on an other-year day', () => {
    expect(formatDayHeading('2025-06-11T14:05:00Z', 'America/Toronto', NOW)).toBe(
      'Wednesday, Jun 11, 2025',
    );
  });

  it('honours the render zone near the UTC boundary — 1am ET is the local day', () => {
    // 2026-06-12 05:00 UTC is Jun 12 (1am) in Toronto but Jun 11 in Vancouver.
    expect(formatDayHeading('2026-06-12T05:00:00Z', 'America/Toronto', NOW)).toBe(
      'Friday, Jun 12',
    );
    expect(formatDayHeading('2026-06-12T05:00:00Z', 'America/Vancouver', NOW)).toBe(
      'Thursday, Jun 11',
    );
  });
});

describe('DEFAULT_TIMEZONE', () => {
  it('matches the users.timezone schema default', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Toronto');
  });
});

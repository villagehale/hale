import { describe, expect, it } from 'vitest';
import { freeWindowsForDays, unansweredStreak, upcomingDayKeys } from './snapshot';

describe('free windows', () => {
  it('keeps the afternoon after a morning study block', () => {
    const windows = freeWindowsForDays(
      ['2026-10-10'],
      [{ day: '2026-10-10', startMin: 10 * 60, endMin: 12 * 60 + 30, allDay: false }],
    );
    expect(windows).toEqual([
      { day: '2026-10-10', start: '09:00', end: '10:00' },
      { day: '2026-10-10', start: '12:30', end: '20:00' },
    ]);
  });

  it('drops a day that is a real all-day commitment', () => {
    expect(
      freeWindowsForDays(
        ['2026-10-10', '2026-10-11'],
        [{ day: '2026-10-10', startMin: 0, endMin: 0, allDay: true }],
      ),
    ).toEqual([{ day: '2026-10-11', start: '09:00', end: '20:00' }]);
  });
});

describe('upcoming days', () => {
  it('starts on the family-local day, not the UTC one', () => {
    // 02:00Z Friday is still Thursday evening on the east coast.
    expect(upcomingDayKeys(new Date('2026-10-09T02:00:00.000Z'), 'America/New_York', 3)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]);
  });
});

describe('unanswered streak', () => {
  it('counts from the newest send and stops at a reply', () => {
    expect(
      unansweredStreak([
        { at: '2026-10-01T15:00:00Z', replied: true },
        { at: '2026-10-06T15:00:00Z', replied: false },
        { at: '2026-10-08T15:00:00Z', replied: false },
      ]),
    ).toBe(2);
    expect(unansweredStreak([])).toBe(0);
  });
});

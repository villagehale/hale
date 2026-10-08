import { describe, expect, it } from 'vitest';
import { freeWindowsForDays, unansweredStreak } from './snapshot';

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
        ['2026-10-10'],
        [{ day: '2026-10-10', startMin: 0, endMin: 0, allDay: true }],
      ),
    ).toEqual([]);
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
  });
});

import { describe, expect, it } from 'vitest';
import { dayKey, fillWindow, lastDays } from './window';

describe('dayKey', () => {
  it('buckets an instant by the admin timezone, not UTC', () => {
    // 03:00 UTC is 23:00 the PREVIOUS day in Toronto (EDT, UTC-4).
    expect(dayKey(new Date('2026-07-10T03:00:00.000Z'))).toBe('2026-07-09');
    expect(dayKey(new Date('2026-07-10T12:00:00.000Z'))).toBe('2026-07-10');
  });
});

describe('lastDays', () => {
  it('produces a continuous run ending today, oldest first', () => {
    expect(lastDays(3, '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('crosses the spring DST boundary without skipping a day', () => {
    // DST starts 2026-03-08 in Toronto.
    expect(lastDays(4, '2026-03-10')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });
});

describe('fillWindow', () => {
  it('zero-fills the days the query returned nothing for', () => {
    const rows = [{ day: '2026-03-01', n: 5 }];
    expect(fillWindow(rows, 3, { n: 0 }, '2026-03-01')).toEqual([
      { day: '2026-02-27', n: 0 },
      { day: '2026-02-28', n: 0 },
      { day: '2026-03-01', n: 5 },
    ]);
  });

  it('keeps only the sliced window — older rows fall away', () => {
    const rows = [
      { day: '2026-02-01', n: 9 },
      { day: '2026-03-01', n: 1 },
    ];
    const out = fillWindow(rows, 2, { n: 0 }, '2026-03-01');
    expect(out).toEqual([
      { day: '2026-02-28', n: 0 },
      { day: '2026-03-01', n: 1 },
    ]);
  });
});

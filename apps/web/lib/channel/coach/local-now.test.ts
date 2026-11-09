import { describe, expect, it } from 'vitest';
import { familyLocalNow } from './local-now';

describe('familyLocalNow', () => {
  it('reads the family clock, not UTC: Sunday evening is still Sunday in Toronto', () => {
    expect(familyLocalNow(new Date('2026-11-09T02:30:00Z'), 'America/Toronto')).toEqual({
      date: '2026-11-08',
      weekday: 'Sunday',
      time: '21:30',
      timeZone: 'America/Toronto',
    });
  });

  it('a US family on the west coast reads its own day', () => {
    const now = familyLocalNow(new Date('2026-11-09T07:30:00Z'), 'America/Los_Angeles');
    expect(now.date).toBe('2026-11-08');
    expect(now.weekday).toBe('Sunday');
    expect(now.time).toBe('23:30');
  });
});

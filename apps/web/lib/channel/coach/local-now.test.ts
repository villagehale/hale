import { describe, expect, it } from 'vitest';
import { familyLocalNow } from './local-now';

describe('familyLocalNow (VIL-435)', () => {
  it('reads the family clock, not UTC: Thanksgiving Monday in Toronto', () => {
    const now = new Date('2026-10-12T14:07:20Z');
    expect(familyLocalNow(now, 'America/Toronto')).toEqual({
      date: '2026-10-12',
      weekday: 'Monday',
      time: '10:07',
      timeZone: 'America/Toronto',
    });
  });

  it('a late-evening UTC instant is still the previous day out west', () => {
    const now = new Date('2026-10-13T05:30:00Z');
    const v = familyLocalNow(now, 'America/Vancouver');
    expect(v.date).toBe('2026-10-12');
    expect(v.weekday).toBe('Monday');
  });
});

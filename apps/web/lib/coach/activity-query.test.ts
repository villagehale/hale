import { describe, expect, it } from 'vitest';
import { resolveActivityQuery, selectByActivityQuery } from './activity-query';

const TZ = 'America/Toronto';
/** Thursday 8 Oct 2026, 14:00 EDT. */
const THURSDAY = new Date('2026-10-08T18:00:00.000Z');

function row(title: string, eventDate: string | null, summary = '') {
  return { title, summary, eventDate };
}

const WEEK = [
  row('After School Club', '2026-10-09'),
  row('Fanous Lantern Craft', '2026-10-10', 'Saturday afternoon at the library'),
  row('3D Printing Demo', '2026-10-17'),
  row('Board Games', '2026-10-18'),
  row('Robotics Night', '2026-10-21'),
];

describe('resolveActivityQuery', () => {
  it('reads weekend as the coming Saturday and Sunday, and leaves the other words', () => {
    expect(resolveActivityQuery('weekend kids activities', THURSDAY, TZ)).toEqual({
      needle: 'kids activities',
      fromDay: '2026-10-10',
      toDay: '2026-10-11',
    });
  });

  it('reads a bare weekday as that day', () => {
    expect(resolveActivityQuery('Saturday', THURSDAY, TZ)).toEqual({
      needle: null,
      fromDay: '2026-10-10',
      toDay: '2026-10-10',
    });
  });

  it('reads tonight and tomorrow against the family day', () => {
    expect(resolveActivityQuery('tonight', THURSDAY, TZ).fromDay).toBe('2026-10-08');
    expect(resolveActivityQuery('tomorrow swim', THURSDAY, TZ)).toMatchObject({
      needle: 'swim',
      fromDay: '2026-10-09',
      toDay: '2026-10-09',
    });
  });
});

describe('selectByActivityQuery', () => {
  it('returns the dated finds for a time word that is not in any title', () => {
    const picked = selectByActivityQuery(WEEK, 'weekend', THURSDAY, TZ);
    expect(picked.map((item) => item.title)).toEqual(['Fanous Lantern Craft']);
  });

  it('falls back to the date window when the leftover text matches nothing', () => {
    const picked = selectByActivityQuery(WEEK, 'weekend kids activities', THURSDAY, TZ);
    expect(picked.map((item) => item.title)).toEqual(['Fanous Lantern Craft']);
  });

  it('falls back to every dated row when a text query matches nothing and names no time', () => {
    const picked = selectByActivityQuery(WEEK, 'origami', THURSDAY, TZ);
    expect(picked).toHaveLength(WEEK.length);
  });

  it('keeps a text hit inside the window', () => {
    const picked = selectByActivityQuery(WEEK, 'saturday lantern', THURSDAY, TZ);
    expect(picked.map((item) => item.title)).toEqual(['Fanous Lantern Craft']);
  });
});

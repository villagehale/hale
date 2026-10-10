import { describe, expect, it } from 'vitest';
import { type DayCommitment, childCanAttend, parseClockLabel } from './saturday-window';

function block(overrides: Partial<DayCommitment> = {}): DayCommitment {
  return {
    childId: 'kid',
    startMinute: 10 * 60,
    endMinute: 12 * 60 + 30,
    allDay: false,
    transparency: null,
    status: 'confirmed',
    ...overrides,
  };
}

describe('parseClockLabel', () => {
  it('reads a single afternoon clock and a range', () => {
    expect(parseClockLabel('2:00 p.m.')).toEqual({ startMinute: 14 * 60, endMinute: null });
    expect(parseClockLabel('9:30 a.m.-11:00 a.m.')).toEqual({
      startMinute: 9 * 60 + 30,
      endMinute: 11 * 60,
    });
  });
});

describe('childCanAttend', () => {
  it('lets a 2pm craft sit after a 10:00–12:30 study block', () => {
    expect(childCanAttend([block()], parseClockLabel('2:00 p.m.'), 'kid')).toBe(true);
  });

  it('refuses an activity that starts inside the block once travel is included', () => {
    expect(childCanAttend([block()], parseClockLabel('12:00 p.m.'), 'kid')).toBe(false);
  });

  it('does not let one child block a sibling', () => {
    expect(childCanAttend([block()], parseClockLabel('11:00 a.m.'), 'other')).toBe(true);
  });

  it('treats a confirmed all-day entry as the whole day', () => {
    const allDay = block({ allDay: true, startMinute: null, endMinute: null, childId: null });
    expect(childCanAttend([allDay], parseClockLabel('2:00 p.m.'), 'kid')).toBe(false);
  });

  it('ignores a transparent or cancelled all-day entry', () => {
    const transparent = block({
      allDay: true,
      startMinute: null,
      endMinute: null,
      transparency: 'transparent',
      childId: null,
    });
    const cancelled = block({
      allDay: true,
      startMinute: null,
      endMinute: null,
      status: 'cancelled',
      childId: null,
    });
    expect(childCanAttend([transparent], parseClockLabel('2:00 p.m.'), 'kid')).toBe(true);
    expect(childCanAttend([cancelled], parseClockLabel('2:00 p.m.'), 'kid')).toBe(true);
  });

  it('treats unknown transparency on a confirmed all-day entry as a real commitment', () => {
    const unknown = block({
      allDay: true,
      startMinute: null,
      endMinute: null,
      transparency: null,
      status: 'confirmed',
      childId: null,
    });
    expect(childCanAttend([unknown], parseClockLabel('2:00 p.m.'), 'kid')).toBe(false);
  });
});

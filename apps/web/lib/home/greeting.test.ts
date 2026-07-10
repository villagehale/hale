import { describe, expect, it } from 'vitest';
import { homeGreeting, homeStatCells, timeGreeting } from './greeting';

describe('timeGreeting', () => {
  it('reads morning before noon, afternoon midday, evening after 5pm', () => {
    expect(timeGreeting(new Date(2026, 0, 1, 8, 0))).toBe('Good morning');
    expect(timeGreeting(new Date(2026, 0, 1, 11, 59))).toBe('Good morning');
    expect(timeGreeting(new Date(2026, 0, 1, 12, 0))).toBe('Good afternoon');
    expect(timeGreeting(new Date(2026, 0, 1, 16, 59))).toBe('Good afternoon');
    expect(timeGreeting(new Date(2026, 0, 1, 17, 0))).toBe('Good evening');
    expect(timeGreeting(new Date(2026, 0, 1, 23, 30))).toBe('Good evening');
  });
});

describe('homeGreeting', () => {
  const evening = new Date(2026, 0, 1, 19, 0);

  it('warms the phrase with the viewer first name only', () => {
    expect(homeGreeting('Jordan Reyes', evening)).toBe('Good evening, Jordan');
  });

  it('trims surrounding whitespace before splitting', () => {
    expect(homeGreeting('  Alex  ', evening)).toBe('Good evening, Alex');
  });

  it('falls back to the bare phrase — never a dangling comma — with no name', () => {
    expect(homeGreeting(null, evening)).toBe('Good evening');
    expect(homeGreeting('', evening)).toBe('Good evening');
    expect(homeGreeting('   ', evening)).toBe('Good evening');
  });
});

describe('homeStatCells', () => {
  it('shows a count + pluralized label when non-zero', () => {
    const cells = homeStatCells({ logsThisWeek: 1, upcomingHealth: 3, savedPlaces: 5 });
    expect(cells[0]).toEqual({ count: 1, label: 'log this week' });
    expect(cells[1]).toEqual({ count: 3, label: 'health items coming up' });
    expect(cells[2]).toEqual({ count: 5, label: 'saved' });
  });

  it('pluralizes at 2+', () => {
    const cells = homeStatCells({ logsThisWeek: 4, upcomingHealth: 1, savedPlaces: 2 });
    expect(cells[0]).toEqual({ count: 4, label: 'logs this week' });
    expect(cells[1]).toEqual({ count: 1, label: 'health item coming up' });
  });

  it('reads a calm zero phrase — never a fake "0" — when empty', () => {
    const cells = homeStatCells({ logsThisWeek: 0, upcomingHealth: 0, savedPlaces: 0 });
    expect(cells[0]).toEqual({ count: null, label: 'no logs yet this week' });
    expect(cells[1]).toEqual({ count: null, label: 'no health items coming up' });
    expect(cells[2]).toEqual({ count: null, label: 'nothing saved yet' });
  });
});

import { describe, expect, it } from 'vitest';
import { homeStatCells } from './home-stats';

describe('homeStatCells — Home stat row', () => {
  it('shows counts with correct pluralization when non-zero', () => {
    const cells = homeStatCells({ logsThisWeek: 3, upcomingHealth: 1, savedPlaces: 2 });
    expect(cells[0]).toEqual({ count: 3, label: 'logs this week' });
    expect(cells[1]).toEqual({ count: 1, label: 'health item coming up' });
    expect(cells[2]).toEqual({ count: 2, label: 'saved' });
  });

  it('renders an honest zero state (no fake "0"), not a count, for each empty stat', () => {
    const cells = homeStatCells({ logsThisWeek: 0, upcomingHealth: 0, savedPlaces: 0 });
    expect(cells[0]).toEqual({ count: null, label: 'No logs yet this week' });
    expect(cells[1]).toEqual({ count: null, label: 'No health items coming up' });
    expect(cells[2]).toEqual({ count: null, label: 'Nothing saved yet' });
    // No cell ever shows the number 0.
    expect(cells.every((c) => c.count === null || c.count > 0)).toBe(true);
  });

  it('singularizes one log correctly', () => {
    const cells = homeStatCells({ logsThisWeek: 1, upcomingHealth: 0, savedPlaces: 0 });
    expect(cells[0]).toEqual({ count: 1, label: 'log this week' });
  });
});

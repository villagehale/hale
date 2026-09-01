import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lastDays, weekdayOfDayKey } from '~/lib/admin/window';
import { foldHeatmap, TextingHeatmap } from './texting-heatmap';

/**
 * The heatmap's fold: dial-sliced day×hour rows summed into a Mon-first 7×24
 * grid. Day keys are generated relative to today (the fold windows on the
 * real clock, like every dial slice).
 */
describe('foldHeatmap', () => {
  it('sums counts into the right weekday × hour cell and drops out-of-window rows', () => {
    const [dayA, dayB] = lastDays(2);
    if (!dayA || !dayB) throw new Error('lastDays returned too few keys');
    const grid = foldHeatmap(
      [
        { day: dayA, hour: 9, count: 2 },
        { day: dayA, hour: 9, count: 3 },
        { day: dayB, hour: 23, count: 1 },
        { day: '2020-01-01', hour: 9, count: 99 }, // far outside every window
      ],
      7,
    );
    expect(grid[weekdayOfDayKey(dayA)]?.[9]).toBe(5);
    expect(grid[weekdayOfDayKey(dayB)]?.[23]).toBe(1);
    expect(grid.flat().reduce((sum, n) => sum + n, 0)).toBe(6);
  });

  it('windows: a 2-day dial drops the older of two in-trend days', () => {
    const keys = lastDays(5);
    const oldDay = keys[0];
    const today = keys[4];
    if (!oldDay || !today) throw new Error('lastDays returned too few keys');
    const grid = foldHeatmap(
      [
        { day: oldDay, hour: 8, count: 4 },
        { day: today, hour: 8, count: 1 },
      ],
      2,
    );
    expect(grid.flat().reduce((sum, n) => sum + n, 0)).toBe(1);
  });
});

describe('TextingHeatmap render', () => {
  it('names every cell for a screen reader and shows exact counts in the title', () => {
    const [today] = lastDays(1);
    if (!today) throw new Error('lastDays returned no key');
    const html = renderToStaticMarkup(
      createElement(TextingHeatmap, { rows: [{ day: today, hour: 14, count: 3 }] }),
    );
    expect(html).toContain('14:00 — 3 texts');
    expect(html).toContain('aria-label');
    expect(html).toContain('adm-heatmap-cell');
  });

  it('renders the empty-window line instead of a blank grid', () => {
    const html = renderToStaticMarkup(
      createElement(TextingHeatmap, { rows: [{ day: '2020-01-01', hour: 3, count: 2 }] }),
    );
    expect(html).toContain('No rows in this window.');
    expect(html).not.toContain('adm-heatmap-cell');
  });
});

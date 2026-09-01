import { describe, expect, it } from 'vitest';
import { runningTotals } from './bars-chart';

/**
 * The cumulative-families derivation: baseline = total − Σ(all trend rows), so
 * families older than the 365-day trend are carried, never fabricated; rows
 * before the window's first day still count into the first visible value.
 */
describe('runningTotals', () => {
  const allRows = [
    { day: '2026-08-01', value: 2 },
    { day: '2026-08-10', value: 3 },
    { day: '2026-08-12', value: 1 },
  ];

  it('carries pre-trend families as the baseline', () => {
    // total 10, Σrows 6 → 4 families predate the trend window entirely.
    const out = runningTotals(allRows, [{ day: '2026-08-01', value: 2 }], 10);
    expect(out).toEqual([{ day: '2026-08-01', value: 2, cumulative: 6 }]);
  });

  it('adds trend rows older than the sliced window into the first value', () => {
    const window = [
      { day: '2026-08-11', value: 0 },
      { day: '2026-08-12', value: 1 },
    ];
    const out = runningTotals(allRows, window, 10);
    // baseline 4 + (2 + 3 before Aug 11) = 9, then +0, +1.
    expect(out).toEqual([
      { day: '2026-08-11', value: 0, cumulative: 9 },
      { day: '2026-08-12', value: 1, cumulative: 10 },
    ]);
  });

  it('ends at the stock total when the window covers the whole trend', () => {
    const window = [
      { day: '2026-08-01', value: 2 },
      { day: '2026-08-10', value: 3 },
      { day: '2026-08-12', value: 1 },
    ];
    const out = runningTotals(allRows, window, 10);
    expect(out[out.length - 1]?.cumulative).toBe(10);
  });
});

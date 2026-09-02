import { describe, expect, it } from 'vitest';
import { fleetAxis, formatMsTick } from './spend-client';

/**
 * The latency axis grammar: every chart shares a fixed ~42px tick gutter
 * (margin.left −18 against recharts' default 60px axis), so a tick label must
 * never grow wide enough to clip — the "000ms" bug was `8000ms` overflowing
 * the gutter and losing its leading digits.
 */
describe('formatMsTick', () => {
  it('reads 0ms / 400ms / 800ms style under a second', () => {
    expect(formatMsTick(0)).toBe('0ms');
    expect(formatMsTick(400)).toBe('400ms');
    expect(formatMsTick(800)).toBe('800ms');
    expect(formatMsTick(999)).toBe('999ms');
  });

  it('flips to seconds at 1000ms so labels stay narrow', () => {
    expect(formatMsTick(1000)).toBe('1s');
    expect(formatMsTick(2000)).toBe('2s');
    expect(formatMsTick(7500)).toBe('7.5s');
    expect(formatMsTick(7749)).toBe('7.7s');
    expect(formatMsTick(8000)).toBe('8s');
    expect(formatMsTick(60000)).toBe('60s');
  });

  it('never emits a label wider than the gutter (≤5 chars across the real range)', () => {
    for (const v of [0, 5, 250, 500, 999, 1000, 1500, 2500, 7749, 30000, 99900]) {
      expect(formatMsTick(v).length, `label for ${v}`).toBeLessThanOrEqual(5);
    }
  });
});

/**
 * No-signal windows get a STATED axis. A domain prop alone is not enough:
 * recharts 3 discards even an explicit numeric domain when the series holds
 * zero numeric values (live-probed in Chromium) — only explicit ticks +
 * allowDataOverflow force the axis to render.
 */
describe('fleetAxis', () => {
  it('states quarter ticks when every day is null', () => {
    expect(fleetAxis([null, null, null], 800)).toEqual({
      domain: [0, 800],
      allowDataOverflow: true,
      ticks: [0, 200, 400, 600, 800],
    });
  });

  it('states the axis when the only values are zero', () => {
    expect(fleetAxis([0, null, 0], 100)).toEqual({
      domain: [0, 100],
      allowDataOverflow: true,
      ticks: [0, 25, 50, 75, 100],
    });
  });

  it('lets recharts scale as soon as one real value exists', () => {
    expect(fleetAxis([null, 7749, 0], 800)).toEqual({
      domain: [0, 'auto'],
      allowDataOverflow: false,
    });
  });
});

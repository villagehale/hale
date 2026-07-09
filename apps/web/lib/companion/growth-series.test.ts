import { describe, expect, it } from 'vitest';
import { buildMeasureSeries } from './growth-series';
import type { LogView } from './logs-view';

/**
 * buildMeasureSeries buckets the shared (teen-redacted) logs read into one series
 * per measure kind. The expected values are derived from the spec — bucket by
 * measureKind, keep the input's newest-first order, peak = max value, and only rows
 * that are a measurement episode carrying measureKind + numeric value + unit count.
 */

function measurement(
  id: string,
  measureKind: string,
  value: number,
  unit: string,
  occurredAt: string,
): LogView {
  return {
    id,
    childId: 'c-1',
    episodeType: 'measurement',
    summary: `${value} ${unit}`,
    occurredAt,
    measureKind,
    value,
    unit,
  };
}

describe('buildMeasureSeries', () => {
  it('returns a series for every kind, in weight/height/head order, even with no logs', () => {
    const series = buildMeasureSeries([]);
    expect(series.map((s) => s.kind)).toEqual(['weight', 'height', 'head']);
    for (const s of series) {
      expect(s.readings).toEqual([]);
      expect(s.unit).toBeNull();
      expect(s.peak).toBe(0);
    }
  });

  it('buckets readings by kind, keeps input order, and computes the peak', () => {
    // Two weights (newest first as the read returns them) + one height.
    const logs: LogView[] = [
      measurement('w2', 'weight', 6.4, 'kg', '2026-06-01T10:00:00.000Z'),
      measurement('w1', 'weight', 5.1, 'kg', '2026-05-01T10:00:00.000Z'),
      measurement('h1', 'height', 61, 'cm', '2026-06-01T10:00:00.000Z'),
    ];
    const series = buildMeasureSeries(logs);

    const weight = series.find((s) => s.kind === 'weight');
    expect(weight?.readings.map((r) => r.id)).toEqual(['w2', 'w1']);
    expect(weight?.unit).toBe('kg');
    expect(weight?.peak).toBe(6.4);

    const height = series.find((s) => s.kind === 'height');
    expect(height?.readings.map((r) => r.value)).toEqual([61]);
    expect(height?.peak).toBe(61);

    const head = series.find((s) => s.kind === 'head');
    expect(head?.readings).toEqual([]);
  });

  it('ignores non-measurement episodes and rows missing the lifted numerics', () => {
    const logs: LogView[] = [
      { id: 'f1', childId: 'c-1', episodeType: 'feed', summary: '120 ml', occurredAt: '2026-06-01T10:00:00.000Z', amountMl: 120 },
      // measurement episode but no lifted numerics (a redacted/malformed row) → dropped.
      { id: 'm-bad', childId: 'c-1', episodeType: 'measurement', summary: 'weight', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight' },
      measurement('w1', 'weight', 5.1, 'kg', '2026-05-01T10:00:00.000Z'),
    ];
    const weight = buildMeasureSeries(logs).find((s) => s.kind === 'weight');
    expect(weight?.readings.map((r) => r.id)).toEqual(['w1']);
  });
});

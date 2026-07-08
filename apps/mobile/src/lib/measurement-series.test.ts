import { describe, expect, it } from 'vitest';

import type { LogView } from './api-types';
import { buildMeasureSeries } from './measurement-series';

/**
 * buildMeasureSeries folds the shared, teen-redacted logs page into one growth series
 * per measure kind. It reads ONLY the enum-gated numerics the logs route lifts
 * (measureKind + value + unit) off 'measurement' episodes — so a series can't be built
 * from a raw or foreign payload (rule #1 holds by construction, upstream). Expected
 * values are derived from the spec, not copied from output.
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
    childId: 'c1',
    episodeType: 'measurement',
    summary: `measured ${value}`,
    occurredAt,
    measureKind,
    value,
    unit,
  };
}

describe('buildMeasureSeries', () => {
  it('returns all three kinds in a stable order even when some are empty', () => {
    const series = buildMeasureSeries([]);
    expect(series.map((s) => s.kind)).toEqual(['weight', 'height', 'head']);
    for (const s of series) {
      expect(s.readings).toEqual([]);
      expect(s.unit).toBeNull();
      expect(s.peak).toBe(0);
    }
  });

  it('buckets readings into their kind, keeping the page order (newest first) and the peak', () => {
    const logs: LogView[] = [
      measurement('w2', 'weight', 10.4, 'kg', '2026-07-06T08:00:00Z'),
      measurement('w1', 'weight', 9.8, 'kg', '2026-06-06T08:00:00Z'),
      measurement('h1', 'height', 62, 'cm', '2026-07-05T08:00:00Z'),
    ];

    const series = buildMeasureSeries(logs);
    const weight = series.find((s) => s.kind === 'weight');
    const height = series.find((s) => s.kind === 'height');
    const head = series.find((s) => s.kind === 'head');

    expect(weight?.readings.map((r) => r.id)).toEqual(['w2', 'w1']);
    expect(weight?.unit).toBe('kg');
    expect(weight?.peak).toBe(10.4);
    expect(height?.readings.map((r) => r.value)).toEqual([62]);
    expect(height?.unit).toBe('cm');
    expect(head?.readings).toEqual([]);
  });

  it('ignores non-measurement rows and measurement rows missing the lifted numerics', () => {
    const logs: LogView[] = [
      { id: 'n1', childId: 'c1', episodeType: 'nap', summary: 'Napped 45 min', occurredAt: '2026-07-06T08:00:00Z', durationMin: 45 },
      // a 'measurement' episode whose numerics weren't lifted (e.g. a redacted/foreign
      // shape upstream stripped them) contributes nothing — never charted as zero.
      { id: 'm-bare', childId: 'c1', episodeType: 'measurement', summary: 'measured', occurredAt: '2026-07-06T08:00:00Z' },
      measurement('w1', 'weight', 9.8, 'kg', '2026-06-06T08:00:00Z'),
    ];

    const series = buildMeasureSeries(logs);
    const weight = series.find((s) => s.kind === 'weight');
    expect(weight?.readings.map((r) => r.id)).toEqual(['w1']);
    // The nap and the bare-measurement rows added nothing anywhere.
    expect(series.reduce((n, s) => n + s.readings.length, 0)).toBe(1);
  });

  it('drops an unknown measureKind (a second-writer/free-shape token never becomes a series)', () => {
    const logs: LogView[] = [
      measurement('x', 'temperature', 37, 'C', '2026-07-06T08:00:00Z'),
    ];
    const series = buildMeasureSeries(logs);
    expect(series.reduce((n, s) => n + s.readings.length, 0)).toBe(0);
  });
});

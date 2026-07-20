import { describe, expect, it } from 'vitest';
import { buildGrowthHeader, zToPercentile } from './growth-header.js';
import { type LogView, percentileOrdinal } from './logs-view.js';

/**
 * zToPercentile is the standard-normal CDF as a whole percentile. Expected values
 * are the KNOWN Φ(z) of the normal distribution (statistics, not this code's
 * output): z=0 is the median (50th), ±1 SD are the 84th/16th, ±2 SD the 98th/2nd,
 * and the classic 90th/95th/5th quantiles fall at z = 1.2816 / 1.6449 / -1.6449.
 * The tails clamp to [1, 99] (growth-chart convention).
 */
describe('zToPercentile — the WHO z-score as a percentile', () => {
  it('maps the standard quantiles to their known percentiles', () => {
    expect(zToPercentile(0)).toBe(50);
    expect(zToPercentile(1)).toBe(84);
    expect(zToPercentile(-1)).toBe(16);
    expect(zToPercentile(2)).toBe(98);
    expect(zToPercentile(-2)).toBe(2);
    expect(zToPercentile(1.2816)).toBe(90);
    expect(zToPercentile(1.6449)).toBe(95);
    expect(zToPercentile(-1.6449)).toBe(5);
  });

  it('clamps the far tails to [1, 99] rather than showing 0 / 100', () => {
    expect(zToPercentile(3)).toBe(99);
    expect(zToPercentile(4)).toBe(99);
    expect(zToPercentile(-3)).toBe(1);
    expect(zToPercentile(-4)).toBe(1);
  });
});

describe('percentileOrdinal', () => {
  it('applies the ordinal suffix, including the 11–13 exception', () => {
    expect(percentileOrdinal(1)).toBe('1st');
    expect(percentileOrdinal(2)).toBe('2nd');
    expect(percentileOrdinal(3)).toBe('3rd');
    expect(percentileOrdinal(4)).toBe('4th');
    expect(percentileOrdinal(11)).toBe('11th');
    expect(percentileOrdinal(12)).toBe('12th');
    expect(percentileOrdinal(13)).toBe('13th');
    expect(percentileOrdinal(21)).toBe('21st');
    expect(percentileOrdinal(42)).toBe('42nd');
    expect(percentileOrdinal(50)).toBe('50th');
  });
});

function measurement(
  kind: string,
  value: number,
  occurredAt: string,
  unit = kind === 'weight' ? 'kg' : 'cm',
): LogView {
  return {
    id: `${kind}-${occurredAt}`,
    childId: 'c-1',
    episodeType: 'measurement',
    summary: `${value} ${unit}`,
    occurredAt,
    measureKind: kind,
    value,
    unit,
  };
}

/**
 * buildGrowthHeader composes the latest reading per kind with its WHO read. A
 * girl born 2025-01-01 measured 2025-07-01 (6 completed months) at 7.5 kg sits
 * very close to the WHO median for a 6-month girl (M ≈ 7.3 kg), so her weight
 * percentile lands near the middle — the assertion pins the honest structure
 * (assessed + a mid-range percentile), not a hand-computed z.
 */
describe('buildGrowthHeader', () => {
  const GIRL = { dateOfBirth: '2025-01-01', biologicalSex: 'female', gestationalWeeks: 40 };

  it('takes the NEWEST reading per kind regardless of input order', () => {
    const logs = [
      measurement('weight', 6.0, '2025-04-01T10:00:00.000Z'),
      measurement('weight', 7.5, '2025-07-01T10:00:00.000Z'),
      measurement('weight', 6.8, '2025-05-15T10:00:00.000Z'),
    ];
    const [stat] = buildGrowthHeader(logs, GIRL);
    expect(stat?.kind).toBe('weight');
    expect(stat?.valueMetric).toBe(7.5);
    expect(stat?.occurredAt).toBe('2025-07-01T10:00:00.000Z');
  });

  it('assesses a reading against the WHO standard and attaches a percentile', () => {
    const logs = [measurement('weight', 7.5, '2025-07-01T10:00:00.000Z')];
    const [stat] = buildGrowthHeader(logs, GIRL);
    expect(stat?.assessment.state).toBe('assessed');
    if (stat?.assessment.state === 'assessed') {
      expect(stat.assessment.band).toBe('typical');
      // ≈ median → a mid-range percentile, not a tail.
      expect(stat.assessment.percentile).toBeGreaterThan(35);
      expect(stat.assessment.percentile).toBeLessThan(75);
    }
  });

  it('omits the percentile (state only) when biological sex is unknown', () => {
    const logs = [measurement('weight', 7.5, '2025-07-01T10:00:00.000Z')];
    const [stat] = buildGrowthHeader(logs, { ...GIRL, biologicalSex: null });
    expect(stat?.assessment.state).toBe('needs-details');
    expect(stat?.assessment).not.toHaveProperty('percentile');
  });

  it('omits a kind entirely when it has no reading', () => {
    const logs = [measurement('weight', 7.5, '2025-07-01T10:00:00.000Z')];
    const stats = buildGrowthHeader(logs, GIRL);
    expect(stats.map((s) => s.kind)).toEqual(['weight']);
  });
});

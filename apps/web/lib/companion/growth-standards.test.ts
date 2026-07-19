import { describe, expect, it } from 'vitest';
import {
  assessGrowth,
  bandForZ,
  buildGrowthAssessments,
  lmsZScore,
  resolveBiologicalSex,
} from './growth-standards';
import type { LogView } from './logs-view';
import { WHO_GROWTH_LMS, type WhoLmsRow } from './who-growth-data';

/** A committed LMS row for a known-present (measure, sex, month); throws if missing
 * so a wrong index fails loudly rather than reading `undefined`. */
function lms(measure: 'weight' | 'height' | 'head', sex: 'male' | 'female', month: number): WhoLmsRow {
  const row = WHO_GROWTH_LMS[measure][sex][month];
  if (!row) throw new Error(`no WHO row: ${measure}/${sex}/${month}`);
  return row;
}

/**
 * The WHO growth engine. Expected z-scores are anchored to WHO's OWN published
 * per-SD cutoff values (the SD2 / SD3 columns of the same z-score tables the LMS
 * rows come from): feeding WHO's published +2 SD reading through the committed LMS
 * row must return z ≈ +2. That derives the expectation from the standard, not from
 * this code's output.
 */

function measurement(over: Partial<LogView> & { measureKind: string; value: number; occurredAt: string }): LogView {
  return {
    id: over.id ?? 'm1',
    childId: 'c1',
    episodeType: 'measurement',
    summary: 'reading',
    unit: 'kg',
    ...over,
  };
}

describe('lmsZScore against WHO published SD cutoffs', () => {
  it('reproduces ±2 / ±3 SD for boys weight at 12 months', () => {
    const { l, m, s } = lms('weight', 'male', 12); // L=0.0645, M=9.646, S=0.10925
    expect(lmsZScore(m, l, m, s)).toBeCloseTo(0, 6); // the median is exactly z = 0
    expect(lmsZScore(11.983, l, m, s)).toBeCloseTo(2, 2); // WHO +2 SD
    expect(lmsZScore(7.741, l, m, s)).toBeCloseTo(-2, 2); // WHO −2 SD
    expect(lmsZScore(13.341, l, m, s)).toBeCloseTo(3, 2); // WHO +3 SD
  });

  it('reproduces ±2 SD for girls weight at 6 months (negative L)', () => {
    const { l, m, s } = lms('weight', 'female', 6); // L=-0.0759
    expect(lmsZScore(9.341, l, m, s)).toBeCloseTo(2, 2); // WHO +2 SD
    expect(lmsZScore(5.733, l, m, s)).toBeCloseTo(-2, 2); // WHO −2 SD
  });

  it('reproduces +2 SD for head (12mo) and height (24mo), where L = 1', () => {
    const head = lms('head', 'male', 12);
    expect(lmsZScore(48.633, head.l, head.m, head.s)).toBeCloseTo(2, 2);
    const height = lms('height', 'male', 24);
    expect(lmsZScore(93.911, height.l, height.m, height.s)).toBeCloseTo(2, 2);
  });

  it('uses the log-form when L = 0', () => {
    // With L=0, z = ln(value/M)/S. A value one S in log-space above M gives z = 1.
    const m = 10;
    const s = 0.1;
    expect(lmsZScore(m * Math.exp(s), 0, m, s)).toBeCloseTo(1, 6);
  });
});

describe('bandForZ — inclusive ±2 boundary', () => {
  it('is typical within ±2 SD (inclusive) and review beyond', () => {
    expect(bandForZ(0)).toBe('typical');
    expect(bandForZ(2)).toBe('typical');
    expect(bandForZ(-2)).toBe('typical');
    expect(bandForZ(2.0001)).toBe('review');
    expect(bandForZ(-2.0001)).toBe('review');
    expect(bandForZ(4)).toBe('review');
  });
});

describe('resolveBiologicalSex — clinical tokens only, never gender', () => {
  it('accepts unambiguous natal-sex tokens, case/space-insensitive', () => {
    expect(resolveBiologicalSex('male')).toBe('male');
    expect(resolveBiologicalSex('Female')).toBe('female');
    expect(resolveBiologicalSex('  M ')).toBe('male');
    expect(resolveBiologicalSex('f')).toBe('female');
  });

  it('returns null for gender-identity words, unknowns, and blanks', () => {
    for (const v of [null, undefined, '', 'boy', 'girl', 'nonbinary', 'intersex', 'unknown', 'x']) {
      expect(resolveBiologicalSex(v)).toBeNull();
    }
  });
});

describe('assessGrowth — precedence and honest states', () => {
  const base = { measureKind: 'weight' as const, valueMetric: 9.646, ageMonths: 12 };

  it('assesses a median reading as z 0 / typical', () => {
    const r = assessGrowth({ ...base, biologicalSex: 'male', gestationalWeeks: null });
    expect(r).toEqual({ state: 'assessed', z: expect.closeTo(0, 6), band: 'typical' });
  });

  it('flags a preterm birth BEFORE anything else (even with sex + valid age)', () => {
    expect(assessGrowth({ ...base, biologicalSex: 'male', gestationalWeeks: 34 })).toEqual({
      state: 'preterm',
    });
    // Preterm wins even when sex is missing (adding sex later must not start a
    // chronological-age computation on a preterm baby).
    expect(assessGrowth({ ...base, biologicalSex: null, gestationalWeeks: 30 })).toEqual({
      state: 'preterm',
    });
  });

  it('treats 37 weeks and unknown gestation as term', () => {
    expect(assessGrowth({ ...base, biologicalSex: 'male', gestationalWeeks: 37 }).state).toBe(
      'assessed',
    );
    expect(assessGrowth({ ...base, biologicalSex: 'male', gestationalWeeks: null }).state).toBe(
      'assessed',
    );
  });

  it('needs details when sex is unusable', () => {
    expect(assessGrowth({ ...base, biologicalSex: 'nonbinary', gestationalWeeks: null })).toEqual({
      state: 'needs-details',
    });
  });

  it('is out-of-range past 60 months, below 0, or for a non-positive value', () => {
    expect(assessGrowth({ ...base, ageMonths: 61, biologicalSex: 'male', gestationalWeeks: null }).state).toBe('out-of-range');
    expect(assessGrowth({ ...base, ageMonths: -1, biologicalSex: 'male', gestationalWeeks: null }).state).toBe('out-of-range');
    expect(assessGrowth({ ...base, valueMetric: 0, biologicalSex: 'male', gestationalWeeks: null }).state).toBe('out-of-range');
  });
});

describe('buildGrowthAssessments — per-kind read of the latest reading', () => {
  const male = { dateOfBirth: '2020-01-10', biologicalSex: 'male', gestationalWeeks: null };

  it('assesses the latest reading of each kind at the age it was taken', () => {
    // A weight of the WHO median, logged when the child was exactly 12 months old,
    // even though "today" is years later — age must come from the reading's date.
    const value = lms('weight', 'male', 12).m;
    const out = buildGrowthAssessments(
      [measurement({ measureKind: 'weight', value, occurredAt: '2021-01-10T10:00:00.000Z' })],
      male,
    );
    expect(out).toEqual([
      { measureKind: 'weight', state: 'assessed', z: expect.closeTo(0, 6), band: 'typical' },
    ]);
  });

  it('picks the newest reading per kind, not the first in the array', () => {
    // Older (12mo) reading is the median → typical; newer (17mo) reading is far
    // above the band → review. With the array ordered older-first, a 'review'
    // result proves selection is by date, not array position.
    const older = measurement({ id: 'old', measureKind: 'weight', value: lms('weight', 'male', 12).m, occurredAt: '2021-01-10T10:00:00.000Z' });
    const newer = measurement({ id: 'new', measureKind: 'weight', value: 20, occurredAt: '2021-06-10T10:00:00.000Z' });
    const out = buildGrowthAssessments([older, newer], male);
    expect(out).toEqual([
      { measureKind: 'weight', state: 'assessed', z: expect.any(Number), band: 'review' },
    ]);
  });

  it('omits a kind whose latest reading is outside WHO 0–5y (honest absence)', () => {
    const teen = { dateOfBirth: '2008-01-10', biologicalSex: 'male', gestationalWeeks: null };
    const out = buildGrowthAssessments(
      [measurement({ measureKind: 'weight', value: 50, occurredAt: '2021-01-10T10:00:00.000Z' })],
      teen,
    );
    expect(out).toEqual([]);
  });

  it('reports preterm / needs-details uniformly per kind', () => {
    const reading = measurement({ measureKind: 'weight', value: 9.646, occurredAt: '2021-01-10T10:00:00.000Z' });
    expect(buildGrowthAssessments([reading], { ...male, gestationalWeeks: 32 })).toEqual([
      { measureKind: 'weight', state: 'preterm' },
    ]);
    expect(buildGrowthAssessments([reading], { ...male, biologicalSex: null })).toEqual([
      { measureKind: 'weight', state: 'needs-details' },
    ]);
  });

  it('ignores non-measurement rows and readings missing a numeric value', () => {
    const out = buildGrowthAssessments(
      [
        { id: 'f', childId: 'c1', episodeType: 'feed', summary: 'fed', occurredAt: '2021-01-10T10:00:00.000Z', amountMl: 120 },
        { id: 'x', childId: 'c1', episodeType: 'measurement', summary: 'w', occurredAt: '2021-01-10T10:00:00.000Z', measureKind: 'weight' },
      ],
      male,
    );
    expect(out).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { deriveStage, stageFromAgeInMonths } from './family-stage';

/**
 * The mobile replica of @hale/types deriveStage (the bundle can't import package
 * code — same hand-mirror rule as INTENTS). Expected stages are derived from the
 * spec boundaries [12, 48, 156] (newborn <12mo, toddler 12–47mo, child 48–155mo,
 * teenager 156mo+), never from the function's output — so this replica can't
 * silently drift from the canonical one.
 */

describe('stageFromAgeInMonths', () => {
  it('maps each boundary month to the spec stage', () => {
    expect(stageFromAgeInMonths(0)).toBe('newborn');
    expect(stageFromAgeInMonths(11)).toBe('newborn');
    expect(stageFromAgeInMonths(12)).toBe('toddler');
    expect(stageFromAgeInMonths(47)).toBe('toddler');
    expect(stageFromAgeInMonths(48)).toBe('child');
    expect(stageFromAgeInMonths(155)).toBe('child');
    expect(stageFromAgeInMonths(156)).toBe('teenager');
    expect(stageFromAgeInMonths(216)).toBe('teenager');
  });
});

describe('deriveStage', () => {
  // A fixed "now" so completed-month arithmetic is deterministic.
  const now = new Date(2026, 5, 15); // 2026-06-15, local

  it('reads a YYYY-MM-DD DOB as its literal calendar day (no UTC shift)', () => {
    // Born exactly 12 months before now → 12 completed months → toddler.
    expect(deriveStage('2025-06-15', now)).toBe('toddler');
    // One day short of 12 months → 11 completed → still newborn.
    expect(deriveStage('2025-06-16', now)).toBe('newborn');
  });

  it('places a 4-year-old in child and a 13-year-old in teenager', () => {
    expect(deriveStage('2022-06-15', now)).toBe('child'); // 48mo
    expect(deriveStage('2013-05-15', now)).toBe('teenager'); // 157mo
  });
});

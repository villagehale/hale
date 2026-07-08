import { describe, expect, it } from 'vitest';

import { deriveStage, stageFromAgeInMonths, youngestChildStage } from './family-stage';

/**
 * The mobile replica of @hale/types deriveStage (the bundle can't import package
 * code — same hand-mirror rule as INTENTS). The pre-auth preview call needs a
 * client-derived stage; the honest teen line and the "no activities" boundary
 * hang off it. Expected stages are derived from the spec boundaries [12, 48, 156]
 * (newborn <12mo, toddler 12–47mo, child 48–155mo, teenager 156mo+), never from
 * the function's output — so this replica can't silently drift from the canonical
 * one.
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

describe('youngestChildStage', () => {
  const now = new Date(2026, 5, 15);

  it('returns the stage of the youngest child (the newest DOB drives discovery)', () => {
    // A teen sibling must not suppress the newborn's activities.
    const stage = youngestChildStage(
      [{ dateOfBirth: '2011-01-01' }, { dateOfBirth: '2026-01-01' }],
      now,
    );
    expect(stage).toBe('newborn');
  });

  it('is teenager only when every child is a teenager (the honest teen preview)', () => {
    const stage = youngestChildStage(
      [{ dateOfBirth: '2010-01-01' }, { dateOfBirth: '2012-01-01' }],
      now,
    );
    expect(stage).toBe('teenager');
  });

  it('ignores children without a birthday and returns null when none are dated', () => {
    expect(
      youngestChildStage([{ dateOfBirth: '' }, { dateOfBirth: '2026-01-01' }], now),
    ).toBe('newborn');
    expect(youngestChildStage([{ dateOfBirth: '' }], now)).toBeNull();
    expect(youngestChildStage([], now)).toBeNull();
  });
});

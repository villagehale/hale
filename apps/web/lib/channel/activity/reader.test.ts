import { describe, expect, it } from 'vitest';
import { FAMILY_FIT_PREFERENCE_LIMIT, selectFitPreferences, toFitChild } from './reader';

const NOW = new Date('2026-10-30T12:00:00Z');

describe('family fit slice (VIL-518)', () => {
  it('keeps a young child named with whole-year age', () => {
    expect(toFitChild({ id: 'c1', name: 'Zephyrina', dateOfBirth: '2022-06-01' }, NOW)).toEqual({
      childId: 'c1',
      name: 'Zephyrina',
      stage: expect.any(String),
      ageYears: 4,
    });
  });

  it('reduces a teen to a stage with no name or age', () => {
    const teen = toFitChild({ id: 't1', name: 'Sam', dateOfBirth: '2011-01-01' }, NOW);
    expect(teen).toEqual({ childId: 't1', name: null, stage: 'teenager', ageYears: null });
  });

  it("drops a teen's preferences and caps the slice", () => {
    const rows = [
      { childId: 't1', key: 'scary', value: 'loves' },
      ...Array.from({ length: 12 }, (_, i) => ({ childId: null, key: `k${i}`, value: i })),
    ];
    const prefs = selectFitPreferences(rows, new Set(['t1']));
    expect(prefs).toHaveLength(FAMILY_FIT_PREFERENCE_LIMIT);
    expect(prefs.some((p) => p.childId === 't1')).toBe(false);
  });
});

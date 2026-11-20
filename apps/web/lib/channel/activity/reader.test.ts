import { describe, expect, it } from 'vitest';
import {
  FAMILY_FIT_PREFERENCE_LIMIT,
  type FitFactRow,
  selectFitPreferences,
  toFitChild,
} from './reader';

const NOW = new Date('2026-10-30T12:00:00Z');

function row(overrides: Partial<FitFactRow> = {}): FitFactRow {
  return {
    childId: null,
    key: 'indoor',
    value: 'indoors',
    source: 'parent_message',
    sourcedAt: new Date('2026-10-20T09:00:00Z'),
    ...overrides,
  };
}

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
      row({ childId: 't1', key: 'scary', value: 'loves' }),
      ...Array.from({ length: 12 }, (_, i) => row({ key: `k${i}`, value: i })),
    ];
    const prefs = selectFitPreferences(rows, new Set(['t1']));
    expect(prefs).toHaveLength(FAMILY_FIT_PREFERENCE_LIMIT);
    expect(prefs.some((p) => p.childId === 't1')).toBe(false);
  });
});

describe('family fit provenance (VIL-519)', () => {
  it('carries where each fact came from and the day it was seen', () => {
    const prefs = selectFitPreferences(
      [
        row({ key: 'indoor', source: 'parent_message' }),
        row({ key: 'stroller', source: 'inferred', sourcedAt: new Date('2026-09-01T23:30:00Z') }),
      ],
      new Set(),
    );
    expect(prefs).toEqual([
      { childId: null, key: 'indoor', value: 'indoors', source: 'parent_message', seenOn: '2026-10-20' },
      { childId: null, key: 'stroller', value: 'indoors', source: 'inferred', seenOn: '2026-09-01' },
    ]);
  });

  it('two rows for one (child, key): the later-seen one wins, never both', () => {
    const prefs = selectFitPreferences(
      [
        row({ key: 'swim', value: 'loves', sourcedAt: new Date('2026-08-01T00:00:00Z') }),
        row({ key: 'swim', value: 'not any more', sourcedAt: new Date('2026-10-01T00:00:00Z') }),
        row({ childId: 'c1', key: 'swim', value: 'loves' }),
      ],
      new Set(),
    );
    expect(prefs.map((p) => [p.childId, p.value])).toEqual([
      [null, 'not any more'],
      ['c1', 'loves'],
    ]);
  });
});

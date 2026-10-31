import { describe, expect, it } from 'vitest';
import {
  FAMILY_FIT_PREFERENCE_LIMIT,
  FAMILY_FIT_RECHECK_LIMIT,
  type FitFactRow,
  selectFitPreferences,
  toFitChild,
} from './reader';

const NOW = new Date('2026-10-30T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const row = (over: Partial<FitFactRow> = {}): FitFactRow => ({
  childId: null,
  key: 'indoor',
  value: true,
  confidence: 0.9,
  source: 'parent_message',
  sourcedAt: ago(1),
  ...over,
});

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

  it("drops a teen's preferences (fresh or stale) and caps the slice", () => {
    const rows = [
      row({ childId: 't1', key: 'scary' }),
      row({ childId: 't1', key: 'old', sourcedAt: ago(900) }),
      ...Array.from({ length: 12 }, (_, i) => row({ key: `k${i}`, value: i })),
    ];
    const { preferences, recheck } = selectFitPreferences(rows, new Set(['t1']), NOW);
    expect(preferences).toHaveLength(FAMILY_FIT_PREFERENCE_LIMIT);
    expect(preferences.some((p) => p.childId === 't1')).toBe(false);
    expect(recheck).toEqual([]);
  });
});

describe('family fit provenance + freshness (VIL-519)', () => {
  it('carries where each fact came from and when it was seen', () => {
    const { preferences } = selectFitPreferences(
      [row({ source: 'inferred', sourcedAt: ago(3) })],
      new Set(),
      NOW,
    );
    expect(preferences).toEqual([
      { childId: null, key: 'indoor', value: true, source: 'inferred', seenOn: '2026-10-27' },
    ]);
  });

  it('an unknown source reads as legacy rather than being trusted as a parent said it', () => {
    const { preferences } = selectFitPreferences([row({ source: 'mystery' })], new Set(), NOW);
    expect(preferences[0]?.source).toBe('legacy');
  });

  it('a guess goes stale before a thing the parent said', () => {
    const rows = [
      row({ key: 'guess', source: 'inferred', sourcedAt: ago(100) }),
      row({ key: 'said', source: 'parent_message', sourcedAt: ago(100) }),
    ];
    const { preferences, recheck } = selectFitPreferences(rows, new Set(), NOW);
    expect(preferences.map((p) => p.key)).toEqual(['said']);
    expect(recheck).toEqual([{ childId: null, key: 'guess', seenOn: '2026-07-22' }]);
  });

  it('a stale fact never leaks its old value, and the recheck list is short', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ key: `old${i}`, value: `secret${i}`, sourcedAt: ago(400) }),
    );
    const { preferences, recheck } = selectFitPreferences(rows, new Set(), NOW);
    expect(preferences).toEqual([]);
    expect(FAMILY_FIT_RECHECK_LIMIT).toBe(1);
    expect(recheck).toHaveLength(1);
    expect(JSON.stringify(recheck)).not.toContain('secret');
  });

  it('a low-confidence hunch never ranks', () => {
    const { preferences, recheck } = selectFitPreferences(
      [row({ confidence: 0.4 })],
      new Set(),
      NOW,
    );
    expect(preferences).toEqual([]);
    expect(recheck).toEqual([]);
  });

  it.each([
    'age',
    'kid_age',
    'children_age_range',
    'home_city',
    'postal_code',
    'neighbourhood',
    'grade',
  ])('the record wins over a remembered %s', (key) => {
    const { preferences, recheck } = selectFitPreferences([row({ key })], new Set(), NOW);
    expect(preferences).toEqual([]);
    expect(recheck).toEqual([]);
  });

  it('keeps preferences that only mention home in passing', () => {
    const { preferences } = selectFitPreferences(
      [row({ key: 'max_drive_from_home' })],
      new Set(),
      NOW,
    );
    expect(preferences).toHaveLength(1);
  });

  it('two rows for one (child, key): the later-seen one wins, never both', () => {
    const rows = [
      row({ key: 'setting', value: 'outdoor', sourcedAt: ago(10) }),
      row({ key: 'setting', value: 'indoor', sourcedAt: ago(2) }),
    ];
    const { preferences } = selectFitPreferences(rows, new Set(), NOW);
    expect(preferences.map((p) => p.value)).toEqual(['indoor']);
  });
});

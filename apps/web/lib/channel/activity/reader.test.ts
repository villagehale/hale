import { describe, expect, it } from 'vitest';
import {
  FAMILY_FIT_PREFERENCE_LIMIT,
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

  it('a 120-day inferred swimming guess is omitted, key and value', () => {
    const value = 'Lin loves swimming lessons';
    const fit = selectFitPreferences(
      [
        row({ key: 'loves_swimming', value, source: 'inferred', sourcedAt: ago(120) }),
        row({ key: 'indoor', value: true, source: 'parent_message', sourcedAt: ago(1) }),
      ],
      new Set(),
      NOW,
    );
    expect(fit.preferences.map((p) => p.key)).toEqual(['indoor']);
    expect(fit.recheck).toEqual([]);
    expect(JSON.stringify(fit)).not.toMatch(/swim/i);
  });

  it.each([
    ['ville', 'place'],
    ['quartier', 'place'],
    ['lives_in', 'place'],
    ['âge', 'age'],
    ['edad', 'age'],
  ] as const)(
    'a %s fact marked %s is dropped, and the key spelling is not the signal',
    (key, record) => {
      const marked = selectFitPreferences(
        [row({ key, value: { record, text: 'Georgetown' } })],
        new Set(),
        NOW,
      );
      expect(marked.preferences).toEqual([]);
      expect(marked.recheck).toEqual([]);
      expect(JSON.stringify(marked)).not.toContain('Georgetown');

      const unmarked = selectFitPreferences(
        [row({ key, value: 'weekend market' })],
        new Set(),
        NOW,
      );
      expect(unmarked.preferences.map((p) => p.key)).toEqual([key]);
    },
  );

  it('a guess goes stale before a thing the parent said, and the stale key is not named', () => {
    const rows = [
      row({ key: 'guess', source: 'inferred', sourcedAt: ago(100) }),
      row({ key: 'said', source: 'parent_message', sourcedAt: ago(100) }),
    ];
    const { preferences, recheck } = selectFitPreferences(rows, new Set(), NOW);
    expect(preferences.map((p) => p.key)).toEqual(['said']);
    expect(recheck).toEqual([]);
    expect(JSON.stringify({ preferences, recheck })).not.toContain('guess');
  });

  it('a stale fact never leaks its old value or its key', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ key: `old${i}`, value: `secret${i}`, sourcedAt: ago(400) }),
    );
    const fit = selectFitPreferences(rows, new Set(), NOW);
    expect(fit.preferences).toEqual([]);
    expect(fit.recheck).toEqual([]);
    expect(JSON.stringify(fit)).not.toContain('secret');
    expect(JSON.stringify(fit)).not.toContain('old0');
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

  it.each(['home_city', 'date_of_birth', 'age'])(
    'an unmarked stale %s is dropped, the same as a stale age or place fact',
    (key) => {
      const value = key === 'home_city' ? 'Georgetown' : '3';
      const fit = selectFitPreferences(
        [row({ key, value, source: 'parent_message', sourcedAt: ago(400) })],
        new Set(),
        NOW,
      );
      expect(fit.preferences).toEqual([]);
      expect(fit.recheck).toEqual([]);
      expect(JSON.stringify(fit)).not.toContain('Georgetown');
    },
  );

  it('a fresh unmarked fact still rides', () => {
    const { preferences } = selectFitPreferences(
      [row({ key: 'indoor', value: true, source: 'parent_message', sourcedAt: ago(20) })],
      new Set(),
      NOW,
    );
    expect(preferences.map((p) => p.key)).toEqual(['indoor']);
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

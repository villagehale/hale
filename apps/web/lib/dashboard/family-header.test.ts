import { describe, expect, it } from 'vitest';
import { type ChildRow, stagePhrase, toFamilyHeader } from './family-header.js';

/**
 * Expectations hand-derived from STAGE_BOUNDARIES_MONTHS = [12, 48, 156].
 * `now` pinned to 2026-06-15; day-15 births so each age lands on its boundary:
 *   2026-01-15 = 5mo → newborn, 2025-01-15 = 17mo → toddler,
 *   2020-06-15 = 72mo → child, 2010-06-15 = 192mo → teenager.
 */
const NOW = new Date(2026, 5, 15);

function child(overrides: Pick<ChildRow, 'id' | 'name' | 'dateOfBirth'>): Pick<ChildRow, 'id' | 'name' | 'dateOfBirth'> {
  return overrides;
}

describe('toFamilyHeader', () => {
  it('labels each child with its derived stage and reports the spanned union', () => {
    const header = toFamilyHeader(
      [
        child({ id: 'baby', name: 'Maya', dateOfBirth: '2026-01-15' }),
        child({ id: 'teen', name: 'Theo', dateOfBirth: '2010-06-15' }),
      ],
      NOW,
    );

    expect(header.children).toEqual([
      { id: 'baby', name: 'Maya', stage: 'newborn', stageLabel: 'newborn' },
      { id: 'teen', name: 'Theo', stage: 'teenager', stageLabel: 'teenager' },
    ]);
    expect(header.stages).toEqual(['newborn', 'teenager']);
  });

  it('orders the union by childhood regardless of input order, no dupes', () => {
    const header = toFamilyHeader(
      [
        child({ id: 'c', name: 'Sam', dateOfBirth: '2020-06-15' }), // child
        child({ id: 't', name: 'Ada', dateOfBirth: '2025-01-15' }), // toddler
        child({ id: 'c2', name: 'Lee', dateOfBirth: '2020-06-15' }), // child (dup stage)
      ],
      NOW,
    );
    expect(header.stages).toEqual(['toddler', 'child']);
    expect(header.children.map((c) => c.stageLabel)).toEqual(['child', 'toddler', 'child']);
  });

  it('is empty for a family with no children', () => {
    const header = toFamilyHeader([], NOW);
    expect(header.children).toEqual([]);
    expect(header.stages).toEqual([]);
  });
});

describe('stagePhrase', () => {
  it('joins a single stage plainly and multiple with +', () => {
    expect(stagePhrase(['newborn'])).toBe('newborn');
    expect(stagePhrase(['newborn', 'teenager'])).toBe('newborn + teenager');
  });

  it('is empty for no stages', () => {
    expect(stagePhrase([])).toBe('');
  });
});

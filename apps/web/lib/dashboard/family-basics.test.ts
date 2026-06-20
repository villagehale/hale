import { describe, expect, it } from 'vitest';
import { toFamilyBasics } from './family-basics.js';

const NOW = new Date('2026-06-17T12:00:00Z');

describe('toFamilyBasics', () => {
  it('passes structured location + plan through and derives each child stage live from date_of_birth', () => {
    const view = toFamilyBasics(
      {
        country: 'Canada',
        province: 'Ontario',
        city: 'Toronto',
        postalCode: 'M5V 2T6',
        planTier: 'plus',
      },
      [
        { id: 'a', name: 'Robin', dateOfBirth: '2026-03-15' }, // ~3mo → newborn
        { id: 'b', name: 'Sam', dateOfBirth: '2010-01-01' }, // 16y → teenager
      ],
      NOW,
    );

    expect(view.location).toEqual({
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
    });
    expect(view.planTier).toBe('plus');
    expect(view.children).toEqual([
      { id: 'a', name: 'Robin', dateOfBirth: '2026-03-15', stageLabel: 'newborn' },
      { id: 'b', name: 'Sam', dateOfBirth: '2010-01-01', stageLabel: 'teenager' },
    ]);
  });

  it('falls back to an empty location and the free plan when the family row is null', () => {
    const view = toFamilyBasics(null, [], NOW);
    expect(view.location).toEqual({
      country: null,
      province: null,
      city: null,
      postalCode: null,
    });
    expect(view.planTier).toBe('free');
    expect(view.children).toEqual([]);
  });
});

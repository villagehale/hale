import { describe, expect, it } from 'vitest';
import { toFamilyBasics } from './family-basics.js';

const NOW = new Date('2026-06-17T12:00:00Z');

describe('toFamilyBasics', () => {
  it('passes structured location + plan + validated intents through and derives each child stage live from date_of_birth', () => {
    const view = toFamilyBasics(
      {
        country: 'Canada',
        province: 'Ontario',
        city: 'Toronto',
        postalCode: 'M5V 2T6',
        planTier: 'plus',
        // out of order, with an unknown value the mapper must drop
        intents: ['health', 'activities', 'groceries'],
        foundingNumber: 7,
      },
      [
        // ~3mo → newborn, with the sensitive optional fields set
        {
          id: 'a',
          name: 'Robin',
          lastName: 'Vega',
          dateOfBirth: '2026-03-15',
          gender: 'girl',
          biologicalSex: 'female',
          interests: ['swimming', 'music'],
        },
        // 16y → teenager, bare optional fields (biological sex unset)
        {
          id: 'b',
          name: 'Sam',
          lastName: null,
          dateOfBirth: '2010-01-01',
          gender: 'unspecified',
          biologicalSex: null,
          interests: [],
        },
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
    expect(view.foundingNumber).toBe(7);
    // Unknown 'groceries' dropped, canonical order restored.
    expect(view.intents).toEqual(['activities', 'health']);
    expect(view.children).toEqual([
      {
        id: 'a',
        name: 'Robin',
        lastName: 'Vega',
        dateOfBirth: '2026-03-15',
        gender: 'girl',
        biologicalSex: 'female',
        interests: ['swimming', 'music'],
        stageLabel: 'newborn',
      },
      {
        id: 'b',
        name: 'Sam',
        lastName: null,
        dateOfBirth: '2010-01-01',
        gender: 'unspecified',
        biologicalSex: null,
        interests: [],
        stageLabel: 'teenager',
      },
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
    expect(view.intents).toEqual([]);
    expect(view.foundingNumber).toBeNull();
    expect(view.children).toEqual([]);
  });
});

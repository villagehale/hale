import { describe, expect, it } from 'vitest';
import {
  type FamilySocialProfile,
  type SpotForMatch,
  matchSocialSpot,
  regionForFsa,
} from './match';

const NOW = new Date('2026-09-27T15:00:00Z');

function family(over: Partial<FamilySocialProfile> = {}): FamilySocialProfile {
  return {
    childAgesYears: [4],
    fsa: 'L7C',
    region: null,
    dayTripOk: false,
    mutedCategories: [],
    ...over,
  };
}

function spot(over: Partial<SpotForMatch> = {}): SpotForMatch {
  return {
    category: 'T2',
    region: 'peel',
    geoFsa: 'L7C',
    ageMin: 2,
    ageMax: 8,
    startsAt: new Date('2026-10-10T14:00:00Z'),
    registrationOpensAt: null,
    confidence: 0.8,
    alreadyAlerted: false,
    ...over,
  };
}

describe('regionForFsa', () => {
  it('maps a Toronto FSA, a Halton Hills FSA, and Milton even though Milton is off the rec table', () => {
    expect(regionForFsa('M5V')).toBe('toronto');
    expect(regionForFsa('L7G')).toBe('halton');
    expect(regionForFsa('L9T')).toBe('halton');
    expect(regionForFsa('L9E')).toBe('halton');
  });

  it('returns null when the towns disagree or the code is empty', () => {
    expect(regionForFsa('L0G')).toBeNull();
    expect(regionForFsa(null)).toBeNull();
    expect(regionForFsa('L7')).toBeNull();
  });
});

describe('matchSocialSpot', () => {
  it('alerts when age, area, and timing all fit', () => {
    expect(matchSocialSpot(family(), spot(), NOW)).toEqual({ alert: true, reason: 'alert' });
  });

  it('suppresses a muted category before it looks at age', () => {
    expect(
      matchSocialSpot(family({ mutedCategories: ['T2'], childAgesYears: [] }), spot(), NOW),
    ).toEqual({
      alert: false,
      reason: 'muted',
    });
  });

  it('suppresses low confidence, no children, an unstated age, and an age that does not overlap', () => {
    expect(matchSocialSpot(family(), spot({ confidence: 0.69 }), NOW).reason).toBe(
      'low_confidence',
    );
    expect(matchSocialSpot(family({ childAgesYears: [] }), spot(), NOW).reason).toBe('no_children');
    expect(matchSocialSpot(family(), spot({ ageMin: null, ageMax: null }), NOW).reason).toBe(
      'age_unstated',
    );
    expect(
      matchSocialSpot(family({ childAgesYears: [16] }), spot({ ageMin: 2, ageMax: 5 }), NOW).reason,
    ).toBe('age_mismatch');
  });

  it('pads one year so a child who just aged out of the caption still matches', () => {
    expect(
      matchSocialSpot(family({ childAgesYears: [6] }), spot({ ageMin: 3, ageMax: 5 }), NOW).reason,
    ).toBe('alert');
  });

  it('suppresses a household with no area and a household in another region', () => {
    expect(
      matchSocialSpot(family({ fsa: null, region: null }), spot({ geoFsa: null }), NOW).reason,
    ).toBe('no_area');
    expect(
      matchSocialSpot(
        family({ fsa: 'M5V', region: null }),
        spot({ geoFsa: null, region: 'peel' }),
        NOW,
      ).reason,
    ).toBe('area_mismatch');
  });

  it('matches on FSA even when the named regions differ', () => {
    expect(
      matchSocialSpot(
        family({ fsa: 'L7C', region: 'york' }),
        spot({ geoFsa: 'L7C', region: 'peel' }),
        NOW,
      ).reason,
    ).toBe('alert');
  });

  it('suppresses an undated spot, a spot past the horizon, and one already offered', () => {
    expect(matchSocialSpot(family(), spot({ startsAt: null }), NOW).reason).toBe('no_date');
    expect(
      matchSocialSpot(family(), spot({ startsAt: new Date('2026-12-01T15:00:00Z') }), NOW).reason,
    ).toBe('outside_horizon');
    expect(matchSocialSpot(family(), spot({ alreadyAlerted: true }), NOW).reason).toBe(
      'already_alerted',
    );
  });

  it('lets a registration opening inside the lead window stand in for a far start', () => {
    expect(
      matchSocialSpot(
        family(),
        spot({
          startsAt: new Date('2027-01-01T15:00:00Z'),
          registrationOpensAt: new Date('2026-10-01T15:00:00Z'),
        }),
        NOW,
      ).reason,
    ).toBe('alert');
  });

  it('keeps a day trip quiet unless the household asked for one', () => {
    const trip = spot({ region: 'day_trip', geoFsa: null });
    expect(matchSocialSpot(family(), trip, NOW).reason).toBe('area_mismatch');
    expect(matchSocialSpot(family({ dayTripOk: true }), trip, NOW).reason).toBe('alert');
  });
});

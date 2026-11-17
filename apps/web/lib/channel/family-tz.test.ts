import { registrationSeasonOf } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  CANADA_ZONES,
  UNITED_STATES_ZONES,
  familyTzResolveEnabled,
  homeMetroZone,
  plausibleZones,
  resolveFamilyZone,
} from './family-tz';

const ON = { FAMILY_TZ_RESOLVE_ENABLED: 'true' };

describe('FAMILY_TZ_RESOLVE_ENABLED', () => {
  it('is on only when the value is exactly true', () => {
    expect(familyTzResolveEnabled({})).toBe(false);
    expect(familyTzResolveEnabled({ FAMILY_TZ_RESOLVE_ENABLED: 'true' })).toBe(true);
    expect(familyTzResolveEnabled({ FAMILY_TZ_RESOLVE_ENABLED: 'true\n' })).toBe(false);
    expect(familyTzResolveEnabled({ FAMILY_TZ_RESOLVE_ENABLED: 'TRUE' })).toBe(false);
    expect(familyTzResolveEnabled({ FAMILY_TZ_RESOLVE_ENABLED: '1' })).toBe(false);
    expect(familyTzResolveEnabled(ON)).toBe(true);
  });
});

describe('resolveFamilyZone', () => {
  const blank = {
    storedTimezone: 'UTC',
    resolvedTimezone: null,
    knownPlaceZone: null,
    country: null as 'CA' | 'US' | null,
    postalCode: null,
    areaCoarse: null,
    phone: null,
    city: null,
    province: null,
    statedCityZone: null,
    statedCityZones: null,
    householdZone: null,
  };

  it('keeps a stored America/New_York zone and does not treat UTC as one', () => {
    expect(resolveFamilyZone({ ...blank, storedTimezone: 'America/New_York' })).toEqual({
      status: 'resolved',
      zone: 'America/New_York',
      source: 'stored',
    });
    expect(resolveFamilyZone(blank).status).toBe('unresolved');
  });

  it('prefers the place, then the phone area, then the metro, then a stated region', () => {
    expect(
      resolveFamilyZone({
        ...blank,
        country: 'CA',
        postalCode: 'M5V 2T6',
        phone: '+12125550100',
        city: 'Toronto',
        province: 'Ontario',
      }),
    ).toMatchObject({ status: 'resolved', zone: 'America/Toronto', source: 'place' });

    expect(
      resolveFamilyZone({ ...blank, phone: '+14165550199', city: 'Toronto', country: 'CA' }),
    ).toMatchObject({ status: 'resolved', zone: 'America/Toronto', source: 'phone' });

    expect(resolveFamilyZone({ ...blank, phone: '+12125550100' })).toMatchObject({
      status: 'resolved',
      zone: 'America/New_York',
      source: 'phone',
    });

    expect(
      resolveFamilyZone({ ...blank, country: 'CA', city: 'Scarborough', province: 'Ontario' }),
    ).toMatchObject({ status: 'resolved', zone: 'America/Toronto', source: 'metro' });

    expect(resolveFamilyZone({ ...blank, country: 'CA', province: 'Alberta' })).toMatchObject({
      status: 'resolved',
      zone: 'America/Edmonton',
      source: 'stated',
    });

    expect(
      resolveFamilyZone({ ...blank, statedCityZone: 'America/Los_Angeles', city: 'Seattle' }),
    ).toMatchObject({ status: 'resolved', zone: 'America/Los_Angeles', source: 'stated' });
  });

  it('uses the other parent’s zone when this one was never set', () => {
    expect(resolveFamilyZone({ ...blank, householdZone: 'America/Chicago' })).toEqual({
      status: 'resolved',
      zone: 'America/Chicago',
      source: 'household',
    });
  });

  it('does not pick one zone for an area code that spans two', () => {
    const result = resolveFamilyZone({ ...blank, phone: '+18505550100' });
    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.zones).toEqual(['America/Chicago', 'America/New_York']);
  });

  it('with nothing stored, covers every zone Hale serves in Canada and the US', () => {
    const result = resolveFamilyZone(blank);
    expect(result).toEqual({
      status: 'unresolved',
      zones: [...CANADA_ZONES, ...UNITED_STATES_ZONES],
    });
  });

  it('narrows to the country once a place said which one', () => {
    expect(plausibleZones({ country: 'US', statedCityZones: null, phoneSpans: null })).toEqual(
      UNITED_STATES_ZONES,
    );
    expect(homeMetroZone('US', null, 'York')).toBeNull();
    expect(homeMetroZone('CA', 'Ontario', 'York')).toBe('America/Toronto');
  });
});

describe('season keys follow the resolved zone', () => {
  const boundary = new Date('2026-10-01T00:00:00.000Z');

  it('is still fall in New York when UTC has already rolled to winter', () => {
    expect(registrationSeasonOf(boundary, 'UTC').key).toBe('2027-winter');
    expect(registrationSeasonOf(boundary, 'America/New_York').key).toBe('2026-fall');
  });
});

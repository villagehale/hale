import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptStatedCountry,
  currencyOfPlace,
  intakeLocationFromPlace,
  intakeStatedPlaceEnabled,
  resolveStatedPlace,
  timezoneForAreas,
} from './stated-place';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveStatedPlace', () => {
  it('places a US ZIP and a Canadian postal code, and keeps a city in that country', async () => {
    const seattle = await resolveStatedPlace({
      postalCode: '98103',
      city: 'Seattle',
      country: 'US',
      region: 'Washington',
    });
    expect(seattle).toMatchObject({
      kind: 'postal',
      city: 'Seattle',
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
    });
    const toronto = await resolveStatedPlace({
      postalCode: 'M5V 2T6',
      city: 'Toronto',
      country: 'CA',
      region: null,
    });
    expect(toronto).toMatchObject({
      city: 'Toronto',
      countryCode: 'CA',
      timezone: 'America/Toronto',
      currency: 'CAD',
      province: 'Ontario',
    });
    // A city in the other country does not replace the code.
    const crossed = await resolveStatedPlace({
      postalCode: 'M5V 2T6',
      city: 'Seattle',
      country: 'US',
      region: null,
    });
    expect(crossed?.city).toBeNull();
    expect(crossed?.countryCode).toBe('CA');
  });

  it('places a city they named in the country they named, and not a street or a guess', async () => {
    const seattle = await resolveStatedPlace({
      postalCode: null,
      city: 'seattle',
      country: 'US',
      region: null,
    });
    expect(seattle).toMatchObject({
      kind: 'city',
      city: 'Seattle',
      province: 'Washington',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
      postalCode: null,
    });
    const kenora = await resolveStatedPlace({
      postalCode: null,
      city: 'Kenora',
      country: 'CA',
      region: null,
    });
    expect(kenora).toMatchObject({ city: 'Kenora', timezone: 'America/Winnipeg', currency: 'CAD' });
    // No country, a street, a provider, and somewhere else are not a place.
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: 'Seattle',
        country: null,
        region: null,
      }),
    ).toBeNull();
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: '123 Main Street',
        country: 'US',
        region: 'Washington',
      }),
    ).toBeNull();
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: 'YMCA',
        country: 'CA',
        region: 'Ontario',
      }),
    ).toBeNull();
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: 'London',
        country: 'other',
        region: null,
      }),
    ).toBeNull();
    // Scarborough is not a Canadian municipality in the table.
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: 'Scarborough',
        country: 'CA',
        region: 'Ontario',
      }),
    ).toBeNull();
  });

  it('places a city that is one province, and not a name two provinces share', async () => {
    const london = await resolveStatedPlace({
      postalCode: null,
      city: 'London',
      country: 'CA',
      region: null,
    });
    expect(london).toMatchObject({ city: 'London', province: 'Ontario', countryCode: 'CA' });
    expect(
      await resolveStatedPlace({
        postalCode: null,
        city: 'Brighton',
        country: 'CA',
        region: null,
      }),
    ).toBeNull();
    const brighton = await resolveStatedPlace({
      postalCode: null,
      city: 'Brighton',
      country: 'CA',
      region: 'Ontario',
    });
    expect(brighton).toMatchObject({ city: 'Brighton', province: 'Ontario', countryCode: 'CA' });
  });

  it('does not invent one zone when a city sits in two', () => {
    expect(timezoneForAreas('US', ['10001', '90001'])).toBeNull();
    expect(timezoneForAreas('US', [])).toBeNull();
    expect(timezoneForAreas('CA', ['M5V', 'M4K'])).toBe('America/Toronto');
  });
});

describe('intakeLocationFromPlace', () => {
  it('writes the city and the zone, and leaves the clock unset when the zone is unknown', async () => {
    const place = await resolveStatedPlace({
      postalCode: null,
      city: 'Seattle',
      country: 'US',
      region: null,
    });
    if (place === null) throw new Error('seattle should place');
    expect(intakeLocationFromPlace(place)).toMatchObject({
      country: 'United States',
      countryCode: 'US',
      city: 'Seattle',
      province: 'Washington',
      timezone: 'America/Los_Angeles',
      postalCode: null,
    });
    expect(intakeLocationFromPlace({ ...place, timezone: null }).timezone).toBeNull();
  });
});

describe('intakeStatedPlaceEnabled', () => {
  it('is on only for exact true', () => {
    expect(intakeStatedPlaceEnabled()).toBe(false);
    vi.stubEnv('INTAKE_STATED_PLACE_ENABLED', 'true\n');
    expect(intakeStatedPlaceEnabled()).toBe(false);
    vi.stubEnv('INTAKE_STATED_PLACE_ENABLED', 'true');
    expect(intakeStatedPlaceEnabled()).toBe(true);
    expect(currencyOfPlace({ kind: 'postal', postalCode: '98103', areaCoarse: '981' })).toBe('USD');
  });

  it('reads currency off a stored postal place only while the flag is on', () => {
    const place = { kind: 'postal' as const, postalCode: 'M5V', areaCoarse: 'M5V' };
    expect(currencyOfPlace(place)).toBeUndefined();
    vi.stubEnv('INTAKE_STATED_PLACE_ENABLED', 'true');
    expect(currencyOfPlace(place)).toBe('CAD');
  });
});

describe('acceptStatedCountry', () => {
  it('keeps CA, US and other, and drops a sentence', () => {
    expect(acceptStatedCountry('Canada')).toBe('CA');
    expect(acceptStatedCountry('United States')).toBe('US');
    expect(acceptStatedCountry('other')).toBe('other');
    expect(acceptStatedCountry('we live in Seattle')).toBeNull();
  });
});

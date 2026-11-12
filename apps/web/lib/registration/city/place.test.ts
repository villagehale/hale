import { describe, expect, it } from 'vitest';
import { cityKey, ownCityOfRow } from './place';

/**
 * Where a family's registration dates are looked up: the national postal tables' city
 * for their own row, with no hand-kept list of towns. The FSAs here are public area
 * codes, not anyone's address.
 */

const row = (over: Partial<Parameters<typeof ownCityOfRow>[0]> = {}) => ({
  country: 'Canada',
  province: null,
  city: null,
  postalCode: null,
  areaCoarse: null,
  ...over,
});

describe('ownCityOfRow', () => {
  it('places a Toronto family in its registration district', async () => {
    expect(await ownCityOfRow(row({ postalCode: 'M2N 0A1' }))).toEqual({
      status: 'known',
      place: {
        city: 'Toronto',
        provinceOrState: 'Ontario',
        country: 'Canada',
        district: 'north_york',
        residencyKnown: true,
      },
    });
  });

  it('places a family far from the GTA in its own city, with no district', async () => {
    expect(await ownCityOfRow(row({ areaCoarse: 'P3A' }))).toEqual({
      status: 'known',
      place: {
        city: 'Greater Sudbury',
        provinceOrState: 'Ontario',
        country: 'Canada',
        district: null,
        residencyKnown: true,
      },
    });
  });

  it('keeps a town-line FSA in a city but claims no residency there', async () => {
    const thornhill = await ownCityOfRow(row({ postalCode: 'L3T 1A1' }));
    expect(thornhill.status === 'known' && thornhill.place.residencyKnown).toBe(false);
  });

  it('uses a stored city that is a table name, when there is no postal area', async () => {
    const read = await ownCityOfRow(row({ city: 'Ottawa' }));
    expect(read.status === 'known' && read.place.city).toBe('Ottawa');
  });

  it('names why a family has no city, and never guesses one', async () => {
    expect(await ownCityOfRow(row({ country: null, postalCode: 'M2N 0A1' }))).toEqual({
      status: 'unknown',
      reason: 'no_country',
    });
    expect(await ownCityOfRow(row())).toEqual({ status: 'unknown', reason: 'no_postal' });
  });
});

describe('cityKey', () => {
  it('is one key per city and district, whatever the case or accents', () => {
    const base = { provinceOrState: 'Québec', country: 'Canada', district: null };
    expect(cityKey({ ...base, city: 'Montréal' })).toBe(cityKey({ ...base, city: 'MONTREAL' }));
    const toronto = { city: 'Toronto', provinceOrState: 'Ontario', country: 'Canada' };
    expect(cityKey({ ...toronto, district: 'north_york' })).not.toBe(
      cityKey({ ...toronto, district: 'scarborough' }),
    );
  });
});

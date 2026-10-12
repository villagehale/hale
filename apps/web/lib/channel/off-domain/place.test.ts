import { describe, expect, it } from 'vitest';
import { placeOf } from './place';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, from
 * the family's own row, or nothing. Every row here is invented.
 */

const ROW = { country: null, city: null, postalCode: null, areaCoarse: null };

describe('placeOf', () => {
  it("uses the family's own stored city and country when both are set", () => {
    expect(
      placeOf({ country: 'Canada', city: 'Halifax', postalCode: 'A1A 1A1', areaCoarse: 'A1A' }),
    ).toEqual({ status: 'known', city: 'Halifax', country: 'Canada' });
  });

  /** A family that arrived by text has a country and a postal code and no city (intake
   * never asks for one), so the city is the town its postal area belongs to. */
  it.each([
    ['M4K 1A1', 'M4K', 'Toronto'],
    [null, 'L7G', 'Halton Hills'],
    ['L6H 1A1', 'L6H', 'Oakville'],
    ['l4c1a1', null, 'Richmond Hill'],
  ])('derives the city for postal %j, area %j', (postalCode, areaCoarse, city) => {
    expect(placeOf({ ...ROW, country: 'Canada', postalCode, areaCoarse })).toEqual({
      status: 'known',
      city,
      country: 'Canada',
    });
  });

  /** The name a parent says out loud, from the one place a covered town is spelled. */
  it('names a town the way town-label does', () => {
    expect(placeOf({ ...ROW, country: 'Canada', areaCoarse: 'L4A' })).toEqual({
      status: 'known',
      city: 'Stouffville',
      country: 'Canada',
    });
  });

  it('is ambiguous for a postal area that spans two towns, and picks neither', () => {
    expect(
      placeOf({ ...ROW, country: 'Canada', postalCode: 'L4J 1A1', areaCoarse: 'L4J' }),
    ).toEqual({ status: 'unknown', reason: 'ambiguous' });
  });

  it.each([
    ['a postal area outside the covered towns', 'A1A 1A1', 'A1A'],
    ['a rural postal area that spans several towns', null, 'L0P'],
    ['an area that is a neighbourhood name and not a postal area', null, 'North York'],
  ])('is unmapped for %s', (_label, postalCode, areaCoarse) => {
    expect(placeOf({ ...ROW, country: 'Canada', postalCode, areaCoarse })).toEqual({
      status: 'unknown',
      reason: 'unmapped',
    });
  });

  it('is unknown when the family has no postal code or area at all', () => {
    expect(placeOf({ ...ROW, country: 'Canada' })).toEqual({
      status: 'unknown',
      reason: 'no_postal',
    });
  });

  /** A country is never guessed, not even from a postal code only Canada could have. */
  it.each([
    ['a stored city', { city: 'Toronto' }],
    ['a mapped postal code', { postalCode: 'M4K 1A1', areaCoarse: 'M4K' }],
  ])('is unknown with no stored country, whatever else is there: %s', (_label, rest) => {
    expect(placeOf({ ...ROW, ...rest })).toEqual({ status: 'unknown', reason: 'no_country' });
  });

  it('treats a blank city or country as not stored', () => {
    expect(placeOf({ ...ROW, country: '  ', city: 'Toronto' })).toEqual({
      status: 'unknown',
      reason: 'no_country',
    });
    expect(placeOf({ ...ROW, country: 'Canada', city: ' ', areaCoarse: 'M4K' })).toEqual({
      status: 'known',
      city: 'Toronto',
      country: 'Canada',
    });
  });
});

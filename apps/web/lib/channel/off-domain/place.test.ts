import { describe, expect, it } from 'vitest';
import { isOnboardingRegionSupported } from '~/lib/family/location-input';
import { placeOf } from './place';
import ca from './postal-cities/ca.json';
import us from './postal-cities/us.json';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, from
 * the family's own row, or nothing. Every row here is invented; the postal areas and the
 * cities they belong to are real geography (postal-cities/README.md).
 */

const ROW = { country: null, city: null, postalCode: null, areaCoarse: null };

describe('placeOf', () => {
  it("uses the family's own stored city and country when both are set, ahead of any postal code", async () => {
    expect(
      await placeOf({ country: 'Canada', city: 'Halifax', postalCode: 'M4K 1A1', areaCoarse: 'M4K' }),
    ).toEqual({ status: 'known', city: 'Halifax', country: 'Canada' });
    // A country with no postal table still has its stored city.
    expect(await placeOf({ ...ROW, country: 'France', city: 'Lyon' })).toEqual({
      status: 'known',
      city: 'Lyon',
      country: 'France',
    });
  });

  /** A family that arrived by text has a country and a postal code and no city (intake
   * never asks for one), so the city is the one its postal area belongs to. */
  it.each([
    ['a Toronto area', 'M4K 1A1', 'M4K', 'Toronto'],
    ['a Toronto area that was a borough of its own', 'M2N 1A1', 'M2N', 'Toronto'],
    ['an area in the GTA', 'L6H 1A1', 'L6H', 'Oakville'],
    ['an area outside the GTA', 'V6B 1A1', 'V6B', 'Vancouver'],
    ['another, in a third province', 'R3C 1A1', 'R3C', 'Winnipeg'],
    ['an area whose city the source spells without its accent', 'G1K 1A1', 'G1K', 'Québec'],
    ['a postal code typed without its space, in lower case', 'k1p1a1', null, 'Ottawa'],
    ['a family with only the area stored', null, 'L4C', 'Richmond Hill'],
    // Named for a community inside a municipality: placed by where their land lies.
    ['Woodbridge, which is in Vaughan', 'L4L 1A1', 'L4L', 'Vaughan'],
    ['Kanata, which is in Ottawa', 'K2K 1A1', 'K2K', 'Ottawa'],
    ['a Montréal district', 'H2X 1A1', 'H2X', 'Montréal'],
    ['Georgetown, which is in Halton Hills', 'L7G 1A1', 'L7G', 'Halton Hills'],
    ['Bowmanville, which is in Clarington', 'L1C 1A1', 'L1C', 'Clarington'],
    // Thornhill is two areas, and each lies wholly in one municipality.
    ['Thornhill east of Yonge Street', 'L3T 1A1', 'L3T', 'Markham'],
    ['Thornhill west of Yonge Street', 'L4J 1A1', 'L4J', 'Vaughan'],
  ])('derives the city for a Canadian family: %s', async (_label, postalCode, areaCoarse, city) => {
    expect(await placeOf({ ...ROW, country: 'Canada', postalCode, areaCoarse })).toEqual({
      status: 'known',
      city,
      country: 'Canada',
    });
  });

  it.each([
    ['a ZIP code', '80202', '802', 'Denver'],
    ['a ZIP+4', '60601-1234', '606', 'Chicago'],
    ['a ZIP in a third state', '98101', '981', 'Seattle'],
  ])('derives the city for a US family: %s', async (_label, postalCode, areaCoarse, city) => {
    expect(await placeOf({ ...ROW, country: 'United States', postalCode, areaCoarse })).toEqual({
      status: 'known',
      city,
      country: 'United States',
    });
  });

  /** The table is the one for the country ON THE ROW. A code shaped like the other
   * country's is not looked up there. */
  it('never picks the table from the shape of the code', async () => {
    expect(await placeOf({ ...ROW, country: 'Canada', postalCode: '80202' })).toEqual({
      status: 'unknown',
      reason: 'unmapped',
    });
    expect(await placeOf({ ...ROW, country: 'United States', postalCode: 'M4K 1A1' })).toEqual({
      status: 'unknown',
      reason: 'unmapped',
    });
  });

  it.each(['Canada', 'canada', ' CA ', 'CAN'])(
    'reads the Canadian table for a country stored as %j, the names onboarding accepts',
    async (country) => {
      expect(isOnboardingRegionSupported(country)).toBe(true);
      expect(await placeOf({ ...ROW, country, areaCoarse: 'M4K' })).toEqual({
        status: 'known',
        city: 'Toronto',
        country: country.trim(),
      });
    },
  );

  it.each(['United States', 'united states of america', 'USA', 'us'])(
    'reads the US table for a country stored as %j',
    async (country) => {
      expect(await placeOf({ ...ROW, country, postalCode: '80202' })).toEqual({
        status: 'known',
        city: 'Denver',
        country,
      });
    },
  );

  it.each([
    ['a rural area, which covers many towns', null, 'L0P'],
    ['an area the source lists under more than one town', 'L9X 1A1', 'L9X'],
    ['an area the source describes as two places', 'E2E 1A1', 'E2E'],
    ['Acton, whose land is split among three municipalities', 'L7J 1A1', 'L7J'],
    ['Stouffville, a tenth of whose land is in the next township', 'L4A 1A1', 'L4A'],
  ])('is ambiguous for %s, and picks none', async (_label, postalCode, areaCoarse) => {
    expect(await placeOf({ ...ROW, country: 'Canada', postalCode, areaCoarse })).toEqual({
      status: 'unknown',
      reason: 'ambiguous',
    });
  });

  it.each([
    ['a code the table does not have', 'Canada', 'Z9Z 1A1', 'Z9Z'],
    // Downtown Calgary. Its boundary is 98% Rocky View County, and the land is not
    // believed over the name.
    ['an area named for one municipality whose land is mostly another', 'Canada', 'T2P 1A1', 'T2P'],
    ['an area that is a neighbourhood name and not a postal area', 'Canada', null, 'North York'],
    ['a ZIP the table does not have', 'United States', '00000', '000'],
    ['military mail, which has no city', 'United States', '09001', '090'],
    ['a US family with only the three-digit area stored', 'United States', null, '802'],
  ])('is unmapped for %s', async (_label, country, postalCode, areaCoarse) => {
    expect(await placeOf({ ...ROW, country, postalCode, areaCoarse })).toEqual({
      status: 'unknown',
      reason: 'unmapped',
    });
  });

  it('is unknown when the family has no postal code or area at all', async () => {
    expect(await placeOf({ ...ROW, country: 'Canada' })).toEqual({
      status: 'unknown',
      reason: 'no_postal',
    });
  });

  /** A country is never guessed, not even from a postal code only one country could have. */
  it.each([
    ['a stored city', { city: 'Toronto' }],
    ['a Canadian postal code', { postalCode: 'M4K 1A1', areaCoarse: 'M4K' }],
    ['a US ZIP code', { postalCode: '80202', areaCoarse: '802' }],
  ])('is unknown with no stored country, whatever else is there: %s', async (_label, rest) => {
    expect(await placeOf({ ...ROW, ...rest })).toEqual({ status: 'unknown', reason: 'no_country' });
  });

  it('names a country it has no postal table for, and does not try another table', async () => {
    expect(await placeOf({ ...ROW, country: 'France', postalCode: '80202' })).toEqual({
      status: 'unknown',
      reason: 'unsupported_country',
    });
  });

  it('treats a blank city or country as not stored', async () => {
    expect(await placeOf({ ...ROW, country: '  ', city: 'Toronto' })).toEqual({
      status: 'unknown',
      reason: 'no_country',
    });
    expect(await placeOf({ ...ROW, country: 'Canada', city: ' ', areaCoarse: 'M4K' })).toEqual({
      status: 'known',
      city: 'Toronto',
      country: 'Canada',
    });
  });
});

/**
 * A stored city and country are free text (location-input.ts only trims them), and they
 * leave for a search. One that holds a direct identifier, or runs long, is not sent in
 * any form.
 */
describe('a stored place that is not a place', () => {
  it.each([
    ['a street address in the city', { city: '12 Maplewick Crescent', country: 'Canada' }],
    ['an email address in the city', { city: 'pat@example.com', country: 'Canada' }],
    ['a phone number in the city', { city: 'Toronto 416-555-0142', country: 'Canada' }],
    ['a postal code in the city', { city: 'Toronto A1A 1A1', country: 'Canada' }],
    ['a city that runs long', { city: 'Toronto '.repeat(12).trim(), country: 'Canada' }],
    ['an email address in the country', { city: 'Toronto', country: 'pat@example.com' }],
    ['a country that runs long', { city: null, country: 'Canada '.repeat(12).trim() }],
  ])('is unusable for %s, and no fragment of it comes back', async (_label, stored) => {
    const place = await placeOf({ ...ROW, postalCode: 'M4K 1A1', areaCoarse: 'M4K', ...stored });

    expect(place).toEqual({ status: 'unknown', reason: 'unusable_place' });
  });

  /** Positive control: an ordinary name of more than one word is untouched. */
  it.each([
    ['Richmond Hill', 'Canada'],
    ["St. John's", 'Canada'],
    ['Salt Lake City', 'United States of America'],
    ['100 Mile House', 'Canada'],
  ])('sends %s, %s as stored', async (city, country) => {
    expect(await placeOf({ ...ROW, city, country })).toEqual({ status: 'known', city, country });
  });
});

/**
 * The checked-in tables themselves (postal-cities/README.md). What the rule could not
 * reduce to one municipality is in the table as ambiguous or unmapped, not left out.
 */
describe('the postal tables', () => {
  const AMBIGUOUS = -1;
  const UNMAPPED = -2;
  const shape = (table: typeof ca) => ({
    areas: table.codes.length,
    oneCity: table.cityOf.filter((city) => city >= 0).length,
    ambiguous: table.cityOf.filter((city) => city === AMBIGUOUS).length,
    unmapped: table.cityOf.filter((city) => city === UNMAPPED).length,
  });
  /** The names some Canadian area resolves to. A reason is not an index, and names none. */
  const resolvedTo = new Set(ca.cityOf.flatMap((city) => ca.cities[city] ?? []));

  it('hold every area the sources have, each with one city or a named reason for none', () => {
    expect(shape(ca)).toEqual({ areas: 1664, oneCity: 1340, ambiguous: 290, unmapped: 34 });
    expect(shape(us)).toEqual({ areas: 41488, oneCity: 40975, ambiguous: 2, unmapped: 511 });
    for (const table of [ca, us]) {
      expect(table.cityOf).toHaveLength(table.codes.length);
      expect(new Set(table.codes).size).toBe(table.codes.length);
      expect(Math.max(...table.cityOf)).toBeLessThan(table.cities.length);
    }
  });

  it('key Canada by forward sortation area and the US by five-digit ZIP', () => {
    expect(ca.codes.filter((code) => !/^[A-Z]\d[A-Z]$/.test(code))).toEqual([]);
    expect(us.codes.filter((code) => !/^\d{5}$/.test(code))).toEqual([]);
  });

  /** Every Canadian rural area (second character 0) covers many towns. */
  it('resolve no rural Canadian area to a city', () => {
    const rural = ca.codes.flatMap((code, at) => (code[1] === '0' ? [ca.cityOf[at]] : []));

    expect(rural).toHaveLength(185);
    expect(rural.filter((city) => city !== AMBIGUOUS)).toEqual([]);
  });

  /** A neighbourhood, a former borough and a community are not municipalities, and the
   * postal source's own descriptions (a parenthesised list, a compass point) never come
   * out. No area resolves to one. */
  it('resolve an area to a municipality only', () => {
    for (const notACity of [
      'North York',
      'Scarborough',
      'Etobicoke',
      'Georgetown',
      'Thornhill',
      'Woodbridge',
      'Kanata',
    ]) {
      expect(resolvedTo).not.toContain(notACity);
    }
    expect([...resolvedTo].filter((city) => /[()/,]/.test(city))).toEqual([]);
    expect(us.cities.filter((city) => /[()/,\d]/.test(city))).toEqual([]);
    // Positive control: the cities the tests above derive are there.
    expect([...resolvedTo]).toEqual(
      expect.arrayContaining(['Toronto', 'Vancouver', 'Québec', 'Vaughan', 'Halton Hills']),
    );
    expect(us.cities).toEqual(expect.arrayContaining(['Denver', 'Chicago', 'Seattle']));
  });

  /** The Canadian table also holds every incorporated municipality the names data base
   * lists, so a stored city can be recognised where no postal area resolves to it. */
  it('hold the name of a municipality no area resolves to', () => {
    expect(resolvedTo).not.toContain('Tobermory');
    expect(resolvedTo).not.toContain('Northern Bruce Peninsula');
    expect(ca.cities).toContain('Northern Bruce Peninsula');
    expect(ca.cities).not.toContain('Tobermory');
  });

  /** Three traps in the postal source, by name: an area named for a district that shares
   * its name with a town elsewhere, and two named "<city> <compass point>" that are mostly
   * a town of their own. None comes out as the city in its name. */
  it.each([
    ['H1M', UNMAPPED, 'Mercier West is a district of Montréal, not the town of Mercier'],
    ['H1B', AMBIGUOUS, 'Montreal East is mostly the town of Montréal-Est'],
    ['V1Z', AMBIGUOUS, 'Kelowna West is mostly outside Kelowna'],
  ])('leave %s without a city (%i): %s', (code, reason) => {
    expect(ca.cityOf[ca.codes.indexOf(code)]).toBe(reason);
  });
});

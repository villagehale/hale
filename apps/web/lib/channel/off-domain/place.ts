import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { FamilyPlace, PlaceUnknown } from './answer';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, or a
 * named reason there is none (founder, 2026-10-12; see answer.ts).
 *
 * THE FAMILY'S OWN ROWS ARE THE ONLY SOURCE, AND NONE OF THEIR TEXT LEAVES. A stored
 * city, province and country are free text (location-input.ts only trims them), so none
 * is ever sent as stored. Every name that leaves is one checked in beside this file: the
 * country is the name fixed below for the table the row's country selects, and the city
 * is a place name from that table (postal-cities/README.md). A stored city is used only
 * when it IS one of those names, compared without case or accents, and what is sent is
 * the table's spelling of it. Otherwise it is ignored, and the city is the one the
 * family's postal area belongs to. A family that arrived by text has a country and a
 * postal code and no city (intake never asks for one), so that is the usual path. It is
 * geography, checked in, with no network call and no model behind it.
 *
 * THE PROVINCE OR STATE GOES ONLY WITH A CITY NAME THAT NEEDS IT (Sloane, 2026-10-12):
 * one the table has in more than one province or state, so that "Windsor, Canada" is two
 * places. It is the table's name for the one the postal area is in. For a row with a city
 * and no postal area, the stored province only CHOOSES among the table's names for the
 * places that share the city's, by name or postal abbreviation; it is never sent as
 * stored, and when it chooses none the city is not guessed.
 *
 * WHERE THEY ARE NOW, NOT WHERE HOME IS. A family can keep more than one saved area and
 * make one of them active (family-areas.ts). When there is an active one it is the place,
 * read by these same rules with the family's country, and the home row is not used
 * beside it: an active area that cannot be named is not swapped for another city.
 *
 * NOTHING HERE GUESSES. The table is the one for the country ON THE ROW, never picked
 * from the shape of the code; a country that is not on the row is never inferred, and one
 * with no table says so. An area the table could not reduce to one municipality is
 * `ambiguous` (it covers more than one town) or `unmapped`.
 *
 * `area_coarse` is not reliably a postal area: for a family with no postal code it holds
 * a city or a neighbourhood name, and for a US family the first three digits of the ZIP.
 * It is read only as a code of the row's country, so neither can come back out as a city.
 *
 * The postal code and the area never leave this function. It returns two or three names
 * from the tables, or a reason.
 */

type PostalCountry = 'CA' | 'US';

interface PostalTable {
  /** Every area the source has, sorted. */
  codes: string[];
  cities: string[];
  /** Beside `codes`: an index into `cities`, or one of the two reasons below. */
  cityOf: number[];
  /** Every province or state, by name, and beside it the postal abbreviation of each. */
  regions: string[];
  regionCodes: string[];
  /** Beside `codes`: an index into `regions`, or -1 where the source names none. */
  regionOf: number[];
  /** The place names found in more than one province or state, by index into `cities`,
   * and beside each the `regions` it is found in. */
  sharedCities: number[];
  sharedRegions: number[][];
}

/** `cityOf` values, as postal-cities/build.mjs writes them. */
const AMBIGUOUS = -1;

/**
 * The names a family's row may hold for the two countries a table is checked in for.
 * Canada's are the ones onboarding's region gate accepts (location-input.ts keeps that set
 * to itself, and it means "cleared to onboard", which is not this question). A Map, because
 * the key is stored text and a plain object also answers to `constructor`.
 */
const TABLE_FOR_COUNTRY: ReadonlyMap<string, PostalCountry> = new Map([
  ['canada', 'CA'],
  ['ca', 'CA'],
  ['can', 'CA'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['usa', 'US'],
  ['us', 'US'],
]);

/** The country as the search is told it. */
const COUNTRY_NAME: Record<PostalCountry, string> = { CA: 'Canada', US: 'United States' };

/** The part of a postal code the table is keyed by: a Canadian forward sortation area, a
 * five-digit US ZIP. */
const AREA_OF: Record<PostalCountry, RegExp> = {
  CA: /^([a-z]\d[a-z])(?:[ -]?\d[a-z]\d)?$/i,
  US: /^(\d{5})(?:-\d{4})?$/,
};

/**
 * LOADED WHEN FIRST NEEDED, and only the one country's: a turn that is dark, or whose
 * question does not turn on where the family is, never opens either file, and neither
 * does a row with no stored city and no postal area to look up. The module system keeps
 * what it loaded.
 */
const TABLES: Record<PostalCountry, () => Promise<PostalTable>> = {
  CA: async () => (await import('./postal-cities/ca.json')).default,
  US: async () => (await import('./postal-cities/us.json')).default,
};

function stored(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A name as it is compared: without case, accents or doubled spaces. */
function folded(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const unknown = (reason: PlaceUnknown): FamilyPlace => ({ status: 'unknown', reason });

/** The regions the table has this place name in, when it has it in more than one. */
function sharedAmong(table: PostalTable, cityAt: number): number[] | undefined {
  return table.sharedRegions[table.sharedCities.indexOf(cityAt)];
}

/** The province or state a stored value names, by name or postal abbreviation, as an
 * index into the table's own. -1 when it names none, or nothing is stored. */
function regionNamed(table: PostalTable, value: string | null): number {
  if (value === null) return -1;
  const asStored = folded(value);
  const byName = table.regions.findIndex((region) => folded(region) === asStored);
  return byName !== -1
    ? byName
    : table.regionCodes.findIndex((code) => code.toLowerCase() === asStored);
}

export async function placeOf(family: {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  areaCoarse: string | null;
}): Promise<FamilyPlace> {
  const storedCountry = stored(family.country);
  if (storedCountry === null) return unknown('no_country');
  const postalCountry = TABLE_FOR_COUNTRY.get(storedCountry.toLowerCase());
  if (postalCountry === undefined) return unknown('unsupported_country');
  const country = COUNTRY_NAME[postalCountry];

  const storedCity = stored(family.city);
  if (storedCity !== null) {
    const asStored = folded(storedCity);
    const table = await TABLES[postalCountry]();
    const cityAt = table.cities.findIndex((city) => folded(city) === asStored);
    const named = table.cities[cityAt];
    if (named !== undefined) {
      const among = sharedAmong(table, cityAt);
      if (among === undefined) return { status: 'known', city: named, country };
      const regionAt = regionNamed(table, stored(family.province));
      const provinceOrState = among.includes(regionAt) ? table.regions[regionAt] : undefined;
      if (provinceOrState !== undefined) {
        return { status: 'known', city: named, provinceOrState, country };
      }
      // A name more than one province has, and the row does not say which: the postal
      // area decides, below.
    }
  }

  const postal = stored(family.postalCode) ?? stored(family.areaCoarse);
  if (postal === null) return unknown('no_postal');
  const area = AREA_OF[postalCountry].exec(postal)?.[1]?.toUpperCase();
  if (area === undefined) return unknown('unmapped');

  const table = await TABLES[postalCountry]();
  const areaAt = table.codes.indexOf(area);
  const cityAt = table.cityOf[areaAt];
  if (cityAt === AMBIGUOUS) return unknown('ambiguous');
  const town = cityAt === undefined ? undefined : table.cities[cityAt];
  if (cityAt === undefined || town === undefined) return unknown('unmapped');
  if (sharedAmong(table, cityAt) === undefined) return { status: 'known', city: town, country };
  const provinceOrState = table.regions[table.regionOf[areaAt] ?? -1];
  // A shared name in an area whose province the source does not give names two places.
  if (provinceOrState === undefined) return unknown('ambiguous');
  return { status: 'known', city: town, provinceOrState, country };
}

/**
 * Reads what {@link placeOf} needs and no other column: the family's country, and the
 * city, province and postal code of its active saved area, or of its home row when it has
 * no active area.
 */
export async function readFamilyPlace(database: Database, familyId: string): Promise<FamilyPlace> {
  const [active] = await database
    .select({
      province: schema.familyAreas.province,
      city: schema.familyAreas.city,
      postalCode: schema.familyAreas.postalCode,
    })
    .from(schema.familyAreas)
    .where(and(eq(schema.familyAreas.familyId, familyId), eq(schema.familyAreas.isActive, true)))
    .limit(1);
  const [family] = await database
    .select({
      country: schema.families.country,
      province: schema.families.province,
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) throw new Error('off-domain place: no family row');
  return placeOf(active ? { ...active, country: family.country, areaCoarse: null } : family);
}

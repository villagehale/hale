import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { FamilyPlace, PlaceUnknown } from './answer';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, or a
 * named reason there is none (founder, 2026-10-12; see answer.ts).
 *
 * THE FAMILY'S OWN ROW IS THE ONLY SOURCE, AND NONE OF ITS TEXT LEAVES. A stored city and
 * country are free text (location-input.ts only trims them), so neither is ever sent as
 * stored. Both names that leave are ones checked in beside this file: the country is the
 * name fixed below for the table the row's country selects, and the city is a place name
 * from that table (postal-cities/README.md). A stored city is used only when it IS one of
 * those names, compared without case or accents, and what is sent is the table's spelling
 * of it. Otherwise it is ignored, and the city is the one the family's postal area belongs
 * to. A family that arrived by text has a country and a postal code and no city (intake
 * never asks for one), so that is the usual path. It is geography, checked in, with no
 * network call and no model behind it.
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
 * The postal code, the area and the province never leave this function. It returns two
 * names or a reason.
 */

type PostalCountry = 'CA' | 'US';

interface PostalTable {
  /** Every area the source has, sorted. */
  codes: string[];
  cities: string[];
  /** Beside `codes`: an index into `cities`, or one of the two reasons below. */
  cityOf: number[];
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

export async function placeOf(family: {
  country: string | null;
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
    const named = (await TABLES[postalCountry]()).cities.find((city) => folded(city) === asStored);
    if (named !== undefined) return { status: 'known', city: named, country };
  }

  const postal = stored(family.postalCode) ?? stored(family.areaCoarse);
  if (postal === null) return unknown('no_postal');
  const area = AREA_OF[postalCountry].exec(postal)?.[1]?.toUpperCase();
  if (area === undefined) return unknown('unmapped');

  const table = await TABLES[postalCountry]();
  const cityAt = table.cityOf[table.codes.indexOf(area)];
  if (cityAt === AMBIGUOUS) return unknown('ambiguous');
  const town = cityAt === undefined ? undefined : table.cities[cityAt];
  if (town === undefined) return unknown('unmapped');
  return { status: 'known', city: town, country };
}

/** Reads the four columns {@link placeOf} needs and no other. */
export async function readFamilyPlace(database: Database, familyId: string): Promise<FamilyPlace> {
  const [family] = await database
    .select({
      country: schema.families.country,
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) throw new Error('off-domain place: no family row');
  return placeOf(family);
}

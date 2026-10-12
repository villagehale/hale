import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { FamilyPlace, PlaceUnknown } from './answer';
import { scrubDirectIdentifiers } from './answer-request';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, or a
 * named reason there is none (founder, 2026-10-12; see answer.ts).
 *
 * THE FAMILY'S OWN ROW IS THE ONLY SOURCE. Its stored city and country when both are
 * there. A family that arrived by text has a country and a postal code and no city
 * (intake never asks for one), so for them the city is the one their postal area belongs
 * to, read from this lane's own postal table (postal-cities/README.md): every Canadian
 * forward sortation area and every US ZIP code a public postal geography has, each with
 * one municipality or the reason it has none. It is geography, checked in, with no
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
 * A STORED CITY AND COUNTRY ARE FREE TEXT (location-input.ts only trims them). Before
 * either leaves it passes the lane's own identifier scrub and a length bound, and one
 * that fails is not sent in any form: no redacted fragment, a named unknown.
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
 * to itself, and it means "cleared to onboard", which is not this question).
 */
const TABLE_FOR_COUNTRY: Record<string, PostalCountry> = {
  canada: 'CA',
  ca: 'CA',
  can: 'CA',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
};

/** The part of a postal code the table is keyed by: a Canadian forward sortation area, a
 * five-digit US ZIP. */
const AREA_OF: Record<PostalCountry, RegExp> = {
  CA: /^([a-z]\d[a-z])(?:[ -]?\d[a-z]\d)?$/i,
  US: /^(\d{5})(?:-\d{4})?$/,
};

/**
 * LOADED WHEN FIRST NEEDED, and only the one country's: a turn that is dark, that has a
 * stored city, or whose question does not turn on where the family is never opens either
 * file. The module system keeps what it loaded.
 */
const TABLES: Record<PostalCountry, () => Promise<PostalTable>> = {
  CA: async () => (await import('./postal-cities/ca.json')).default,
  US: async () => (await import('./postal-cities/us.json')).default,
};

/** Longer than any city or country a family would store, shorter than a sentence. */
const PLACE_NAME_MAX_LENGTH = 64;

function stored(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A stored name that may leave as it is: nothing the identifier scrub would touch. */
function usable(name: string): boolean {
  return name.length <= PLACE_NAME_MAX_LENGTH && scrubDirectIdentifiers(name) === name;
}

const unknown = (reason: PlaceUnknown): FamilyPlace => ({ status: 'unknown', reason });

export async function placeOf(family: {
  country: string | null;
  city: string | null;
  postalCode: string | null;
  areaCoarse: string | null;
}): Promise<FamilyPlace> {
  const country = stored(family.country);
  if (country === null) return unknown('no_country');
  if (!usable(country)) return unknown('unusable_place');
  const city = stored(family.city);
  if (city !== null) {
    return usable(city) ? { status: 'known', city, country } : unknown('unusable_place');
  }

  const postalCountry = TABLE_FOR_COUNTRY[country.toLowerCase()];
  if (postalCountry === undefined) return unknown('unsupported_country');
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

import type { Database } from '@hale/db';
import { type FamilyCountry, postalCountryOf } from '@hale/types';
import type { PlaceUnknown } from '~/lib/channel/off-domain/answer';
import { matchPostalToken, readPlaceRow, searchPlaceOf } from '~/lib/channel/off-domain/place';
import {
  DISTRICT_REGISTRATION_CITY,
  type TorontoDistrict,
  districtForFsa,
  municipalitiesForFsa,
} from '../fsa-municipalities';

/**
 * VIL-684 · the city a family's registration dates are looked up for: wherever they
 * live, never a hand-kept list of towns.
 *
 * The city, province or state and country are the national postal tables' names for
 * the family's own place (off-domain/place.ts): an incorporated municipality, read off
 * the active saved area or the home row, never stored free text. A parent who said
 * where they live now is placed there.
 *
 * TWO REFINEMENTS, both read from the family's postal area and nothing else:
 *   - `district` — Toronto registers by district on different mornings, and the FSA
 *     table knows which one an M code is in. Absent everywhere else.
 *   - `residencyKnown` — false where the GTA table records the FSA as straddling two
 *     towns (Thornhill), and for every US family: the US table names a ZIP's postal city,
 *     not the municipality it lies in (postal-cities/README.md). A resident-first date is
 *     claimed only where residency is not in doubt, the matcher's own rule.
 *
 * A family placed in the city that registers by district (Toronto) with no district of
 * its own (no postal code, or a parent who texted the city's name) is `no_district`: any
 * one morning on that page is another district's.
 */
export interface OwnCity {
  city: string;
  provinceOrState: string | null;
  country: string;
  district: TorontoDistrict | null;
  residencyKnown: boolean;
}

/** A city (and Toronto district) as one reading serves every family in it. Residency is
 * each family's own and is never part of it: the city-level lookup cannot see it. */
export type CityPlace = Omit<OwnCity, 'residencyKnown'>;

export type OwnCityRead =
  | { status: 'known'; place: OwnCity }
  | { status: 'unknown'; reason: PlaceUnknown | 'no_district' };

type PlaceRow = Parameters<typeof searchPlaceOf>[0];

function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The cache key: one reading per city (and Toronto district), shared by every family
 * there. Built from table names only, so no family's own text is ever a key. */
export function cityKey(place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country' | 'district'>) {
  return [place.city, place.provinceOrState ?? '', place.country, place.district ?? '']
    .map(folded)
    .join('|');
}

/** The district a Toronto FSA names, and whether residency is in doubt, from one row.
 * Residency is in doubt where the GTA table records the FSA in two towns, or in one town
 * that is not the city the family is placed in (a saved city with another town's code). */
function refinements(
  row: PlaceRow,
  country: FamilyCountry | undefined,
  city: string,
): Pick<OwnCity, 'district' | 'residencyKnown'> {
  const postal = row.postalCode?.trim() || row.areaCoarse?.trim();
  const token = postal ? matchPostalToken(postal) : null;
  if (country === 'CA' && token?.country === 'CA') {
    const towns = municipalitiesForFsa(token.areaKey);
    const [town] = towns;
    return {
      district: districtForFsa(token.areaKey),
      residencyKnown:
        towns.length === 0 || (towns.length === 1 && town === folded(city).replace(/[\s-]+/g, '_')),
    };
  }
  return { district: null, residencyKnown: country !== 'US' };
}

export async function ownCityOfRow(row: PlaceRow): Promise<OwnCityRead> {
  const place = await searchPlaceOf(row);
  if (place.status === 'unknown') return place;
  if (place.city === undefined) return { status: 'unknown', reason: 'unmapped' };
  const country = postalCountryOf(place.country);
  const refined = refinements(row, country, place.city);
  if (
    country === 'CA' &&
    refined.district === null &&
    folded(place.city) === folded(DISTRICT_REGISTRATION_CITY)
  ) {
    return { status: 'unknown', reason: 'no_district' };
  }
  return {
    status: 'known',
    place: {
      city: place.city,
      provinceOrState: place.provinceOrState ?? null,
      country: place.country,
      ...refined,
    },
  };
}

export async function readOwnCity(database: Database, familyId: string): Promise<OwnCityRead> {
  return ownCityOfRow(await readPlaceRow(database, familyId));
}

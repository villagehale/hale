import type { Database } from '@hale/db';
import type { PlaceUnknown } from '~/lib/channel/off-domain/answer';
import { matchPostalToken, readPlaceRow, searchPlaceOf } from '~/lib/channel/off-domain/place';
import { type TorontoDistrict, districtForFsa, municipalitiesForFsa } from '../fsa-municipalities';

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
 *     towns (Thornhill). The national table names one city for it, but a resident-first
 *     date is claimed only where residency is not in doubt, the matcher's own rule.
 */
export interface OwnCity {
  city: string;
  provinceOrState: string | null;
  country: string;
  district: TorontoDistrict | null;
  residencyKnown: boolean;
}

export type OwnCityRead =
  | { status: 'known'; place: OwnCity }
  | { status: 'unknown'; reason: PlaceUnknown };

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

/** The district a Toronto FSA names, and whether residency is in doubt, from one row. */
function refinements(row: PlaceRow): Pick<OwnCity, 'district' | 'residencyKnown'> {
  const postal = row.postalCode?.trim() || row.areaCoarse?.trim();
  const token = postal ? matchPostalToken(postal) : null;
  if (token?.country !== 'CA') return { district: null, residencyKnown: true };
  return {
    district: districtForFsa(token.areaKey),
    residencyKnown: municipalitiesForFsa(token.areaKey).length <= 1,
  };
}

export async function ownCityOfRow(row: PlaceRow): Promise<OwnCityRead> {
  const place = await searchPlaceOf(row);
  if (place.status === 'unknown') return place;
  if (place.city === undefined) return { status: 'unknown', reason: 'unmapped' };
  return {
    status: 'known',
    place: {
      city: place.city,
      provinceOrState: place.provinceOrState ?? null,
      country: place.country,
      ...refinements(row),
    },
  };
}

export async function readOwnCity(database: Database, familyId: string): Promise<OwnCityRead> {
  return ownCityOfRow(await readPlaceRow(database, familyId));
}

import type { Database } from '@hale/db';
import type { PlaceUnknown } from '~/lib/channel/off-domain/answer';
import {
  coarsenPlace,
  matchPostalToken,
  readPlaceRow,
  searchPlaceOf,
} from '~/lib/channel/off-domain/place';
import { townLabel } from '~/lib/channel/town-label';
import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';

/**
 * THE TOWN AN ACTIVITY FIND SEARCHES, for a family anywhere in Canada or the US (VIL-590).
 *
 * `town` is the only location that crosses the border with a find (deidentify.ts), so it
 * is a city, a province or state and a country read from the checked-in postal tables
 * (off-domain/place.ts) — never the stored text, never the postal code or ZIP. A GTA
 * postal area that names one covered municipality keeps that municipality's label, as
 * before: the registration dataset is keyed by it, and it is a refinement, not the map.
 *
 * A place of fewer than 10,000 people is searched as the nearest larger one, or as its
 * province or state ({@link coarsenPlace}): a search is told a city and a country, and a
 * village names a family. A covered GTA municipality is never that small.
 *
 * No place is a named reason. A find with no place does not run (deidentify.ts refuses
 * it as `no_place`), so "search the general area" is never a search of nowhere.
 */
export type ActivityPlace =
  | { status: 'known'; town: string }
  | { status: 'unknown'; reason: PlaceUnknown };

export async function activityPlaceOf(
  family: Parameters<typeof searchPlaceOf>[0],
): Promise<ActivityPlace> {
  const postal = family.postalCode?.trim() || family.areaCoarse?.trim();
  const token = postal ? matchPostalToken(postal) : null;
  if (token?.country === 'CA') {
    const towns = municipalitiesForFsa(token.areaKey);
    if (towns.length === 1) return { status: 'known', town: townLabel(towns[0]!) };
  }
  const read = await searchPlaceOf(family);
  if (read.status === 'unknown') return read;
  const place = await coarsenPlace(read, true);
  return {
    status: 'known',
    town: [place.city, place.provinceOrState, place.country]
      .filter((part): part is string => part !== undefined)
      .join(', '),
  };
}

/** A postal code or ZIP the parent just gave, placed by its own country (intake). */
export async function activityPlaceOfPostal(code: string): Promise<ActivityPlace> {
  const token = matchPostalToken(code);
  if (token === null) return { status: 'unknown', reason: 'unsupported_country' };
  return activityPlaceOf({
    country: token.countryName,
    province: null,
    city: null,
    postalCode: code,
    areaCoarse: null,
  });
}

/** Where the family is now: the active saved area, or the home row. */
export async function readActivityPlace(
  database: Database,
  familyId: string,
): Promise<ActivityPlace> {
  return activityPlaceOf(await readPlaceRow(database, familyId));
}

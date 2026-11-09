import { type Database, type Municipality, schema } from '@hale/db';
import { postalCountryOf } from '@hale/types';
import { eq } from 'drizzle-orm';
import type { PlaceUnknown } from '~/lib/channel/off-domain/answer';
import { matchPostalToken, placeOf } from '~/lib/channel/off-domain/place';
import { townLabel } from '~/lib/channel/town-label';
import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';

/**
 * IS THIS DESTINATION SOMEWHERE THE FAMILY HAD TO TRAVEL TO?
 *
 * WHY THIS IS NOT THE REGISTRATION UNION. Those are two different lists that happen to
 * overlap, and using the first for the second is the error this module exists to avoid:
 *
 *   · {@link Municipality} is the 21 GTA towns whose registration calendars Hale has
 *     HAND-VERIFIED. It grows town by town as each one is checked, and four GTA
 *     municipalities are simply not on it yet.
 *   · {@link HOME_METRO} is EVERYWHERE A GTA FAMILY DID NOT HAVE TO TRAVEL TO. That is
 *     all 25 GTA municipalities — plus the district and community names a hotel, an
 *     Airbnb or an airline actually writes.
 *
 * Without that second half, a Toronto family whose hotel confirmation says *Scarborough*
 * gets "You're in Scarborough the 12th to the 15th." That is not silence; it is precisely
 * the embarrassing text the precision stance exists to prevent, and the 21-label list
 * produces it for eight of the names below.
 *
 * TWO GUARDS, because one is a model and one is a list. The extraction skill is told to
 * return the municipality-level city ("Toronto, not Scarborough"), with an eval fixture
 * asserting it on a Scarborough hotel confirmation; this list catches it when the model
 * does not.
 *
 * THE HOME IS THE FAMILY'S OWN (VIL-593). This list is the home only for a family whose
 * home IS the GTA — see {@link travelHomeOf}. Every other family is compared with its own
 * home city, so a Seattle family's Seattle hotel is not a trip and its flight to Toronto
 * is. A family whose home cannot be named has no "away" at all.
 */

/** The 21 whose registration calendars are verified — the same spellings the product
 * shows a parent, taken from {@link townLabel} rather than re-title-cased here so a town
 * has exactly one spelling. */
const VERIFIED_MUNICIPALITIES: readonly Municipality[] = [
  'toronto',
  'markham',
  'vaughan',
  'richmond_hill',
  'mississauga',
  'oakville',
  'burlington',
  'halton_hills',
  'brampton',
  'caledon',
  'ajax',
  'pickering',
  'whitby',
  'oshawa',
  'aurora',
  'whitchurch_stouffville',
  'newmarket',
  'king',
  'east_gwillimbury',
  'georgina',
  'uxbridge',
];

/** In the region, with no verified registration calendar — which is a fact about the
 * radar and not about whether a family had to travel. */
const UNVERIFIED_MUNICIPALITIES = ['Milton', 'Clarington', 'Brock', 'Scugog'] as const;

/** What a hotel, an Airbnb or an airline writes instead of the municipality. Every one of
 * these is twenty minutes from home for the cohort, and every one of them would read as
 * AWAY without this half. Hand-maintained, and named in the brief's failure modes as the
 * knob most likely to produce the first bad text. */
const HOME_DISTRICTS = [
  // Toronto
  'Scarborough',
  'North York',
  'Etobicoke',
  'York',
  'East York',
  'Willowdale',
  'Agincourt',
  // Markham / Vaughan / Richmond Hill
  'Thornhill',
  'Woodbridge',
  'Maple',
  'Kleinburg',
  'Concord',
  'Unionville',
  'Milliken',
  'Oak Ridges',
  // Mississauga
  'Port Credit',
  'Streetsville',
  'Erin Mills',
  'Cooksville',
  'Malton',
  // Brampton / Caledon / Halton Hills
  'Bramalea',
  'Bolton',
  'Georgetown',
  'Acton',
] as const;

/**
 * Everywhere a GTA family did not have to travel to: 25 municipalities and the districts
 * a booking writes in their place.
 */
export const HOME_METRO: readonly string[] = [
  ...VERIFIED_MUNICIPALITIES.map((m) => townLabel(m)),
  ...UNVERIFIED_MUNICIPALITIES,
  ...HOME_DISTRICTS,
];

/** Case- and accent-insensitive, punctuation-folded, so `ST. CATHARINES`, `Saint-Sauveur`
 * and `Québec` compare as one thing each. */
function normalise(place: string): string {
  return place
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Where this family's trips are judged from.
 *
 * `gta` keeps {@link HOME_METRO} and its district aliases; `city` is the home city as the
 * postal table spells it; `unknown` carries {@link placeOf}'s reason and means no trip is
 * judged at all — never "away", which would brief a family about its own town.
 */
export type TravelHome =
  | { status: 'gta' }
  | { status: 'city'; city: string }
  | { status: 'unknown'; reason: PlaceUnknown };

export type KnownTravelHome = Exclude<TravelHome, { status: 'unknown' }>;

const HOME_METRO_NORMALISED = new Set(HOME_METRO.map(normalise));

/**
 * The family's HOME, from its own row — not the active saved area `readFamilyPlace`
 * prefers, which is where they are now and is the wrong question for "did they leave".
 *
 * The GTA when the row's postal area belongs to a GTA municipality (an FSA that straddles
 * two of them included) and the row's country is Canada or unstated — a stated country
 * chooses the table, as in {@link placeOf}, so a GTA-shaped code on a US row is not the
 * GTA — or when {@link placeOf} names a {@link HOME_METRO} place in
 * Canada — Ontario's, when the name is one more than one province has. The second half is
 * the four GTA towns the FSA table does not cover. Otherwise the city {@link placeOf}
 * names, or its reason.
 */
export async function travelHomeOf(family: {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  areaCoarse: string | null;
}): Promise<TravelHome> {
  const code = family.postalCode ?? family.areaCoarse;
  const postal = code === null ? null : matchPostalToken(code);
  const country = family.country?.trim() || null;
  const canadianOrUnstated = country === null || postalCountryOf(country) === 'CA';
  if (
    canadianOrUnstated &&
    postal?.country === 'CA' &&
    municipalitiesForFsa(postal.areaKey).length > 0
  ) {
    return { status: 'gta' };
  }
  const place = await placeOf(family);
  if (place.status === 'unknown') return place;
  if (place.city === undefined) return { status: 'unknown', reason: 'unmapped' };
  const inOntario = place.provinceOrState === undefined || place.provinceOrState === 'Ontario';
  if (place.country === 'Canada' && inOntario && HOME_METRO_NORMALISED.has(normalise(place.city))) {
    return { status: 'gta' };
  }
  return { status: 'city', city: place.city };
}

/** {@link travelHomeOf} over the family's own row. */
export async function readTravelHome(database: Database, familyId: string): Promise<TravelHome> {
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
  if (!family) throw new Error('travel home: no family row');
  return travelHomeOf(family);
}

/**
 * True when this city is not somewhere the family already lives.
 *
 * A destination the list has never heard of is AWAY, which is the fail-open direction —
 * deliberately, because the alternative (defaulting to "home") would silence every real
 * trip. The cost of the open direction is bounded by the extraction skill returning the
 * municipality and by the live probe reading the stored city out loud before the feature
 * goes past one household. Outside the GTA the only alias is the city itself: a booking
 * that writes a neighbouring suburb reads as away there.
 */
export function isAwayDestination(city: string, home: KnownTravelHome): boolean {
  if (home.status === 'gta') return !HOME_METRO_NORMALISED.has(normalise(city));
  return normalise(city) !== normalise(home.city);
}

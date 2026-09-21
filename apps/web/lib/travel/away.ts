import type { Municipality } from '@hale/db';
import { townLabel } from '~/lib/channel/town-label';

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
 * STATED LIMIT, and it is a real one: the home region is the GTA for EVERY family. A
 * family that relocates out of it reads every trip home as away. Nine GTA households, so
 * it is theoretical today; the day it is not, this becomes family-relative (a
 * `families.areaCoarse` read) and this list becomes the fallback. It is deliberately NOT
 * family-relative now: `productionActivityFamilyReader.municipality` returns null for the
 * two Thornhill FSAs that straddle a boundary, so the constant would have to be the
 * fallback anyway, and the question is the same for every household in the cohort.
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

const HOME_METRO_NORMALISED = new Set(HOME_METRO.map(normalise));

/**
 * True when this city is not somewhere the family already lives.
 *
 * A destination the list has never heard of is AWAY, which is the fail-open direction —
 * deliberately, because the alternative (defaulting to "home") would silence every real
 * trip. The cost of the open direction is bounded by the extraction skill returning the
 * municipality and by the live probe reading the stored city out loud before the feature
 * goes past one household.
 */
export function isAwayDestination(city: string): boolean {
  return !HOME_METRO_NORMALISED.has(normalise(city));
}

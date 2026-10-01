import type { Municipality } from '@hale/db';
import { municipalityForCity } from '~/lib/civic/project';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type PostalContext, parseCanadianPostal } from './derive';

/**
 * VIL-385 — a place the parent actually gave.
 *
 * A Canadian postal token, or a GTA city. The phone number is not an input:
 * an area code is not a place, and this function cannot see one.
 */

export interface FirstTouchPlace {
  kind: 'postal' | 'city';
  /** FSA for a postal. The city label for a city. Never a street. */
  areaCoarse: string;
  postalCode: string | null;
  /** One municipality when the FSA or the city names exactly one. */
  municipality: Municipality | null;
  city: string | null;
}

/**
 * Free-text cities. Longest first so "north york" wins over a shorter tail.
 * `york`, `king`, `sharon`, and `sutton` are omitted here: they are also
 * ordinary English words and given names. The whole message can still be one
 * of those, via {@link municipalityForCity}, because then the parent typed
 * the city and nothing else.
 */
const FREE_TEXT_CITIES = [
  'whitchurch-stouffville',
  'richmond hill',
  'east gwillimbury',
  'king township',
  'holland landing',
  "jackson's point",
  'jacksons point',
  'king city',
  'mount albert',
  'sutton west',
  'north york',
  'east york',
  'scarborough',
  'etobicoke',
  'mississauga',
  'stouffville',
  'queensville',
  'newmarket',
  'unionville',
  'thornhill',
  'schomberg',
  'pefferlaw',
  'nobleton',
  'kettleby',
  'georgina',
  'keswick',
  'uxbridge',
  'markham',
  'vaughan',
  'toronto',
];

const POSTAL_IN_TEXT =
  /(?:^|[^A-Za-z0-9])([ABCEGHJKLMNPRSTVXY]\d[A-Za-z])(?:[ -]?(\d[A-Za-z]\d))?(?![A-Za-z0-9])/i;

/**
 * A SOURCE_VENUES code. The poster's city is the place we say back. The FSA
 * is the venue's own coarse area, not a street.
 */
export function placeFromVenue(venue: {
  areaCoarse: string;
  poster?: string;
}): FirstTouchPlace | null {
  const postal = parseCanadianPostal(venue.areaCoarse);
  if (!postal) return null;
  const place = fromPostal(postal);
  const city = venue.poster?.trim();
  return city ? { ...place, city } : place;
}

export function placeFromMessage(body: string): FirstTouchPlace | null {
  const postal = postalIn(body);
  if (postal) return fromPostal(postal);
  const city = cityIn(body);
  if (!city) return null;
  return {
    kind: 'city',
    areaCoarse: city.label,
    postalCode: null,
    municipality: city.municipality,
    city: city.label,
  };
}

function fromPostal(postal: PostalContext): FirstTouchPlace {
  const municipalities = resolveMunicipalities(postal.postalCode ?? postal.areaCoarse);
  const only = municipalities.length === 1 ? (municipalities[0] ?? null) : null;
  return {
    kind: 'postal',
    areaCoarse: postal.areaCoarse,
    postalCode: postal.postalCode ?? postal.areaCoarse,
    municipality: only,
    city: null,
  };
}

function postalIn(body: string): PostalContext | null {
  const match = POSTAL_IN_TEXT.exec(body);
  if (!match?.[1]) return null;
  const token = match[2] ? `${match[1]} ${match[2]}` : match[1];
  return parseCanadianPostal(token);
}

function cityIn(body: string): { label: string; municipality: Municipality } | null {
  const trimmed = body
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();
  const whole = municipalityForCity(trimmed);
  if (whole && trimmed.length > 0) {
    return { label: titleCity(trimmed), municipality: whole };
  }
  const folded = body.toLowerCase();
  for (const phrase of FREE_TEXT_CITIES) {
    if (!hasPhrase(folded, phrase)) continue;
    const municipality = municipalityForCity(phrase);
    if (!municipality) continue;
    return { label: titleCity(phrase), municipality };
  }
  return null;
}

function hasPhrase(folded: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, 'i').test(folded);
}

function titleCity(raw: string): string {
  return raw
    .split(/([\s-])/)
    .map((part) =>
      part === ' ' || part === '-' ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

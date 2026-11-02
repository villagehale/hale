import type { Municipality } from '@hale/db';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type PostalContext, parseIntakePostal } from './derive';

/**
 * A place the parent actually gave: a Canadian postal code or a US ZIP.
 * A city name is not enough — country and timezone come from the code.
 * The phone number is not an input: an area code is not a place.
 */

export interface FirstTouchPlace {
  kind: 'postal' | 'city';
  /** FSA for a postal. The city label for a city. Never a street. */
  areaCoarse: string;
  postalCode: string | null;
  /** One municipality when the FSA or the city names exactly one. */
  municipality: Municipality | null;
  city: string | null;
  country?: 'United States';
}

const POSTAL_IN_TEXT =
  /(?:^|[^A-Za-z0-9])([ABCEGHJKLMNPRSTVXY]\d[A-Za-z])(?:[ -]?(\d[A-Za-z]\d))?(?![A-Za-z0-9])/i;
const ZIP_IN_TEXT = /(?:^|[^\d])(\d{5})(?:-(\d{4}))?(?!\d)/;

/**
 * A SOURCE_VENUES code. The poster's city is the place we say back. The FSA
 * is the venue's own coarse area, not a street.
 */
/**
 * A postal code or a city the model already pulled out as its own field.
 * The field has to be that fact and nothing else. This does not search a sentence.
 */
export function placeFromGivenFields(input: {
  postalCode: string | null;
  city: string | null;
}): FirstTouchPlace | null {
  if (input.postalCode) {
    const postal = parseIntakePostal(input.postalCode.trim());
    if (postal) return fromPostal(postal);
  }
  // A city name is not a place we can put a family in. Country and timezone come
  // from a Canadian postal code or a US ZIP, and the model asks for one.
  void input.city;
  return null;
}

export function placeFromVenue(venue: {
  areaCoarse: string;
  poster?: string;
}): FirstTouchPlace | null {
  const postal = parseIntakePostal(venue.areaCoarse);
  if (!postal) return null;
  const place = fromPostal(postal);
  const city = venue.poster?.trim();
  return city ? { ...place, city } : place;
}

export function placeFromMessage(body: string): FirstTouchPlace | null {
  const postal = postalIn(body);
  if (!postal) return null;
  return fromPostal(postal);
}

function fromPostal(postal: PostalContext): FirstTouchPlace {
  const municipalities = postal.countryCode === 'US'
    ? []
    : resolveMunicipalities(postal.postalCode ?? postal.areaCoarse);
  const only = municipalities.length === 1 ? (municipalities[0] ?? null) : null;
  return {
    kind: 'postal',
    areaCoarse: postal.areaCoarse,
    postalCode: postal.postalCode ?? postal.areaCoarse,
    municipality: only,
    city: null,
    ...(postal.country === 'United States' ? { country: postal.country } : {}),
  };
}

function postalIn(body: string): PostalContext | null {
  const zip = ZIP_IN_TEXT.exec(body);
  if (zip?.[1]) {
    const token = zip[2] ? `${zip[1]}-${zip[2]}` : zip[1];
    const parsed = parseIntakePostal(token);
    if (parsed) return parsed;
  }
  const match = POSTAL_IN_TEXT.exec(body);
  if (!match?.[1]) return null;
  const token = match[2] ? `${match[1]} ${match[2]}` : match[1];
  return parseIntakePostal(token);
}

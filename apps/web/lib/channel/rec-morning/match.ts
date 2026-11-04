import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';

/**
 * Which rec-morning question a parent just asked — a string test, no model.
 *
 * Narrow on purpose. A watch ask, a "waitlisted #3", or "cancel Thursday swim" is
 * someone else's job (the coach, M7, the approval grammar). Claiming those would
 * steal a morning Hale is already holding, or file a report as a FAQ.
 */

export type RecHelloCity =
  | 'toronto'
  | 'markham'
  | 'vaughan'
  | 'richmond_hill'
  | 'mississauga'
  | 'oakville'
  | 'burlington'
  | 'halton_hills'
  | 'brampton'
  | 'caledon'
  | 'ajax'
  | 'pickering'
  | 'whitby'
  | 'oshawa'
  | 'whitchurch_stouffville'
  | 'newmarket'
  | 'king'
  | 'east_gwillimbury'
  | 'georgina'
  | 'uxbridge'
  | 'milton';

/**
 * The place a family has on file: the families row's city and postal code, and the
 * family's own zone, which says what day "today" is for a dated fact. Null when no zone
 * is known.
 */
export type RecMorningPlace = {
  city: string | null;
  postal: string | null;
  timeZone: string | null;
};

/**
 * A family's stored place, resolved to the one GTA municipality it is in. Every fact
 * this lane holds is a GTA fact, so a family without one is never a rec-morning family.
 */
export type RecMorningWhere = {
  municipality: RecHelloCity;
  postal: string | null;
  timeZone: string | null;
};

export type RecMorningTopic =
  | 'toronto_swim'
  | 'toronto_rec'
  | 'toronto_waitlist'
  | 'toronto_wishlist'
  | 'toronto_efun'
  | 'ymca_gta_swim'
  | 'ymca_follow'
  | 'brampton_swim'
  | 'brampton_rec'
  | 'markham'
  | 'mississauga'
  | 'caledon'
  | 'oakville'
  | 'burlington'
  | 'milton'
  | 'ajax'
  | 'whitby'
  | 'oshawa'
  | 'halton_hills'
  | 'pickering'
  | 'richmond_hill'
  | 'vaughan'
  | 'whitchurch_stouffville'
  | 'newmarket'
  | 'king'
  | 'east_gwillimbury'
  | 'georgina'
  | 'uxbridge'
  | 'two_parents'
  | 'jack_of_sports';

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Multi-word names first so "Halton Hills" is not a miss on "Hills". */
const NAMED_CITIES: readonly { pattern: RegExp; city: RecHelloCity }[] = [
  { pattern: /\bhalton\s+hills\b/, city: 'halton_hills' },
  { pattern: /\brichmond\s+hill\b/, city: 'richmond_hill' },
  // Never a bare \bgwillimbury\b: Bradford WEST Gwillimbury is a different town, and
  // Hale holds no dates for it.
  { pattern: /\beast\s+gwillimbury\b/, city: 'east_gwillimbury' },
  // Never a bare \bking\b - it would eat "King West", "King St" and "the king". The
  // villages are here because their L0G postal code resolves to nothing (see
  // fsa-municipalities limit 2), so naming the village is the only way in.
  {
    pattern: /\bking\s+(?:city|township|twp)\b|\bnobleton\b|\bschomberg\b|\bkettleby\b/,
    city: 'king',
  },
  // Never a bare \bsutton\b (a surname) and never \bsharon\b (a given name, and East
  // Gwillimbury's village - "Sharon can pick up Thursday" is not a rec ask).
  {
    pattern: /\bgeorgina\b|\bkeswick\b|\bsutton\s+west\b|\bpefferlaw\b|\bjackson'?s\s+point\b/,
    city: 'georgina',
  },
  { pattern: /\bmississauga\b/, city: 'mississauga' },
  { pattern: /\bburlington\b/, city: 'burlington' },
  { pattern: /\boakville\b/, city: 'oakville' },
  { pattern: /\bmarkham\b/, city: 'markham' },
  { pattern: /\bbrampton\b/, city: 'brampton' },
  { pattern: /\bcaledon\b/, city: 'caledon' },
  { pattern: /\bpickering\b/, city: 'pickering' },
  { pattern: /\bvaughan\b/, city: 'vaughan' },
  { pattern: /\bwhitby\b/, city: 'whitby' },
  { pattern: /\boshawa\b/, city: 'oshawa' },
  // Matches "Whitchurch-Stouffville" too - the hyphen is a word boundary.
  { pattern: /\bstouffville\b/, city: 'whitchurch_stouffville' },
  { pattern: /\bnewmarket\b/, city: 'newmarket' },
  { pattern: /\buxbridge\b/, city: 'uxbridge' },
  { pattern: /\bmilton\b/, city: 'milton' },
  { pattern: /\bajax\b/, city: 'ajax' },
  { pattern: /\btoronto\b/, city: 'toronto' },
];

const POSTAL_IN_TEXT = /\b([a-z]\d[a-z])(?:\s*\d[a-z]\d)?\b/;

function namedHelloCity(text: string): RecHelloCity | null {
  for (const { pattern, city } of NAMED_CITIES) {
    if (pattern.test(text)) return city;
  }
  return null;
}

/** An FSA written in the ask itself, lowercased as the rest of this matcher folds text. */
export function postalMentioned(body: string): string | null {
  return fold(body).match(POSTAL_IN_TEXT)?.[1] ?? null;
}

function fsaOf(postal: string): string | null {
  const fsa = postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  return /^[A-Z]\d[A-Z]$/.test(fsa) ? fsa : null;
}

function helloCityFromPostal(postal: string): RecHelloCity | null {
  const fsa = fsaOf(postal);
  if (fsa === null) return null;
  const towns = municipalitiesForFsa(fsa);
  if (towns.length !== 1) return null;
  const only = towns[0];
  if (only === undefined || only === 'aurora') return null;
  return only;
}

/**
 * The family's stored place as a GTA municipality: the city on file, then the postal on
 * file. Null for anywhere else, and for an ambiguous or unverified FSA - no guessed town.
 * A stored code that is not a Canadian FSA (a US ZIP) is never in the GTA, whatever
 * town name sits beside it: Richmond Hill and Burlington are US towns too.
 */
export function resolveRecMorningWhere(place: RecMorningPlace | null): RecMorningWhere | null {
  if (place === null) return null;
  if (place.postal && fsaOf(place.postal) === null) return null;
  const fromCity = place.city ? namedHelloCity(fold(place.city)) : null;
  const municipality = fromCity ?? (place.postal ? helloCityFromPostal(place.postal) : null);
  if (municipality === null) return null;
  return { municipality, postal: place.postal, timeZone: place.timeZone };
}

/**
 * City for a first-hello: named in the ask, then a postal in the ask, then the family's
 * own GTA municipality.
 */
export function resolveHelloCity(body: string, where: RecMorningWhere | null): RecHelloCity | null {
  const text = fold(body);
  const named = namedHelloCity(text);
  if (named) return named;

  const postalInText = text.match(POSTAL_IN_TEXT)?.[1];
  if (postalInText) {
    const fromText = helloCityFromPostal(postalInText);
    if (fromText) return fromText;
  }

  return where === null ? null : where.municipality;
}

function isCityRecAsk(text: string): boolean {
  return /\b(rec|recreation|swim|skate|aquatics?|camps?|fall registration|winter-?break)\b/.test(
    text,
  );
}

function cityTopic(city: RecHelloCity, text: string): RecMorningTopic {
  if (city === 'toronto') return /\bswim\b/.test(text) ? 'toronto_swim' : 'toronto_rec';
  if (city === 'brampton') {
    return /\b(swim|skate|aquatics?)\b/.test(text) ? 'brampton_swim' : 'brampton_rec';
  }
  return city;
}

function isNotOurs(text: string): boolean {
  if (/\bwaitlisted\s*#?\d/.test(text)) return true;
  if (/\b(we'?re in|we got in|got in)\b/.test(text) && !/\bwaitlist\b/.test(text)) return true;
  if (/\bcancel\b/.test(text) && /\bswim\b/.test(text)) return true;
  if (/\b(watch|watching|remind me|keep an eye)\b/.test(text)) return true;
  return false;
}

function isYmca(text: string): boolean {
  return /\bymca\b/.test(text) || /\bmy y\b/.test(text) || /\bmyy\.ymcagta\b/.test(text);
}

/**
 * The rec-morning topic this text is asking about, or null when it is not one.
 *
 * First match wins, most specific first: Jack of Sports before "swim", a waitlist ask
 * before everything it mentions, YMCA follow before YMCA clock, a named or known city
 * before the Toronto rec clock.
 * ActiveTO is routed to the first Toronto rec answer so the reply never names it.
 */
export function matchRecMorning(
  body: string,
  where: RecMorningWhere | null,
): RecMorningTopic | null {
  // VIL-591: no GTA place on file, no topic - whatever the text names. The coach answers.
  if (where === null) return null;
  const text = fold(body);
  if (text === '' || isNotOurs(text)) return null;

  if (/\bjack of sports\b/.test(text)) return 'jack_of_sports';

  const city = resolveHelloCity(text, where);
  // The only waitlist fact this lane holds is Toronto's. Any other town's waitlist, or
  // the Y's, is the coach's: a registration date is not an answer to a waitlist ask.
  if (/\bwaitlists?\b/.test(text)) {
    return city === 'toronto' && !isYmca(text) ? 'toronto_waitlist' : null;
  }

  if (
    /\b(two phones|two logins|both parents|one login|one phone)\b/.test(text) ||
    (/\b(co-?parent|other parent)\b/.test(text) && /\b(phone|login|thread|text)\b/.test(text))
  ) {
    return 'two_parents';
  }

  if (isYmca(text)) {
    if (/\b(otter|seal|dolphin|star|ultra|membership|levels?|on deck|9 and under)\b/.test(text)) {
      return 'ymca_follow';
    }
    return 'ymca_gta_swim';
  }

  if (city !== null && city !== 'toronto' && isCityRecAsk(text)) {
    return cityTopic(city, text);
  }

  if (
    /\bwish\s*lists?\b/.test(text) ||
    (/\bfrozen\b/.test(text) && /\b(refresh|search live|wishlist|wish list)\b/.test(text))
  ) {
    return 'toronto_wishlist';
  }

  if (/\befun\b/.test(text)) return 'toronto_efun';

  if (/\bactiveto\b/.test(text) || /\bfitnessto\b/.test(text)) return 'toronto_rec';

  if (/\btoronto\b/.test(text) && /\bswim\b/.test(text)) return 'toronto_swim';

  if (/\btoronto\b/.test(text) && /\b(rec|recreation|fall registration)\b/.test(text)) {
    return 'toronto_rec';
  }

  if (city === 'toronto' && isCityRecAsk(text)) return cityTopic(city, text);

  return null;
}

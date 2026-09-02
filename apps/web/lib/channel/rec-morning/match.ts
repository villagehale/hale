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
  | 'milton';

export type RecMorningWhere = {
  city?: string | null;
  postal?: string | null;
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
  | 'two_parents'
  | 'jack_of_sports';

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Multi-word names first so "Halton Hills" is not a miss on "Hills". */
const NAMED_CITIES: readonly { pattern: RegExp; city: RecHelloCity }[] = [
  { pattern: /\bhalton\s+hills\b/, city: 'halton_hills' },
  { pattern: /\brichmond\s+hill\b/, city: 'richmond_hill' },
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

function helloCityFromPostal(postal: string): RecHelloCity | null {
  const fsa = postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]\d[A-Z]$/.test(fsa)) return null;
  const towns = municipalitiesForFsa(fsa);
  if (towns.length !== 1) return null;
  const only = towns[0];
  if (only === undefined || only === 'aurora') return null;
  return only;
}

/**
 * City for a first-hello: named in the ask, then a postal in the ask, then a
 * city/postal already on the intake or family. Ambiguous or unverified FSAs
 * resolve to nothing — no guessed town, no invented clock.
 */
export function resolveHelloCity(
  body: string,
  where?: RecMorningWhere | null,
): RecHelloCity | null {
  const text = fold(body);
  const named = namedHelloCity(text);
  if (named) return named;

  const postalInText = text.match(POSTAL_IN_TEXT)?.[1];
  if (postalInText) {
    const fromText = helloCityFromPostal(postalInText);
    if (fromText) return fromText;
  }

  if (where?.city) {
    const fromCity = namedHelloCity(fold(where.city));
    if (fromCity) return fromCity;
  }

  if (where?.postal) {
    const fromPostal = helloCityFromPostal(where.postal);
    if (fromPostal) return fromPostal;
  }

  return null;
}

function isCityRecAsk(text: string): boolean {
  return /\b(rec|recreation|swim|skate|aquatics?|camps?|fall registration|waitlists?|winter-?break)\b/.test(
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
 * True when a known city/postal on file could turn this text into a first-hello.
 * False for a watch ask, a report, YMCA, or any ask the text already decides.
 */
export function recMorningCouldUseWhere(body: string): boolean {
  const text = fold(body);
  if (text === '' || isNotOurs(text)) return false;
  if (matchRecMorning(text) !== null) return false;
  return isCityRecAsk(text);
}

/**
 * The rec-morning topic this text is asking about, or null when it is not one.
 *
 * First match wins, most specific first: Jack of Sports before "swim", YMCA follow
 * before YMCA clock, a named or known city before the Toronto waitlist/rec clock.
 * ActiveTO is routed to the first Toronto rec answer so the reply never names it.
 */
export function matchRecMorning(
  body: string,
  where?: RecMorningWhere | null,
): RecMorningTopic | null {
  const text = fold(body);
  if (text === '' || isNotOurs(text)) return null;

  if (/\bjack of sports\b/.test(text)) return 'jack_of_sports';

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

  const city = resolveHelloCity(text, where);
  if (city !== null && city !== 'toronto' && isCityRecAsk(text)) {
    return cityTopic(city, text);
  }

  if (/\bwaitlists?\b/.test(text)) return 'toronto_waitlist';

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

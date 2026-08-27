/**
 * Which rec-morning question a parent just asked — a string test, no model.
 *
 * Narrow on purpose. A watch ask, a "waitlisted #3", or "cancel Thursday swim" is
 * someone else's job (the coach, M7, the approval grammar). Claiming those would
 * steal a morning Hale is already holding, or file a report as a FAQ.
 */

export type RecMorningTopic =
  | 'toronto_swim'
  | 'toronto_rec'
  | 'toronto_waitlist'
  | 'toronto_wishlist'
  | 'toronto_portal'
  | 'ymca_gta_swim'
  | 'brampton_swim'
  | 'two_parents'
  | 'jack_of_sports';

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isNotOurs(text: string): boolean {
  if (/\bwaitlisted\s*#?\d/.test(text)) return true;
  if (/\b(we'?re in|we got in|got in)\b/.test(text) && !/\bwaitlist\b/.test(text)) return true;
  if (/\bcancel\b/.test(text) && /\bswim\b/.test(text)) return true;
  if (/\b(watch|watching|remind me|keep an eye)\b/.test(text)) return true;
  return false;
}

/**
 * The rec-morning topic this text is asking about, or null when it is not one.
 *
 * First match wins, most specific first: Jack of Sports before "swim", YMCA before
 * Toronto swim, waitlist/wishlist/portal before the general rec clock.
 */
export function matchRecMorning(body: string): RecMorningTopic | null {
  const text = fold(body);
  if (text === '' || isNotOurs(text)) return null;

  if (/\bjack of sports\b/.test(text)) return 'jack_of_sports';

  if (
    /\b(two phones|two logins|both parents|one login|one phone)\b/.test(text) ||
    (/\b(co-?parent|other parent)\b/.test(text) && /\b(phone|login|thread|text)\b/.test(text))
  ) {
    return 'two_parents';
  }

  if (/\bymca\b/.test(text) || /\bmy y\b/.test(text) || /\bmyy\.ymcagta\b/.test(text)) {
    return 'ymca_gta_swim';
  }

  if (/\bbrampton\b/.test(text) && /\b(swim|skate|aquatics?)\b/.test(text)) {
    return 'brampton_swim';
  }

  if (/\bwaitlists?\b/.test(text) && /\b(toronto|rec|swim)\b/.test(text)) {
    return 'toronto_waitlist';
  }

  if (
    /\bwish\s*lists?\b/.test(text) ||
    (/\bfrozen\b/.test(text) && /\b(refresh|search live|wishlist|wish list)\b/.test(text))
  ) {
    return 'toronto_wishlist';
  }

  if (/\befun\b/.test(text) || /\bactiveto\b/.test(text) || /\bfitnessto\b/.test(text)) {
    return 'toronto_portal';
  }

  if (/\btoronto\b/.test(text) && /\bswim\b/.test(text)) return 'toronto_swim';

  if (/\btoronto\b/.test(text) && /\b(rec|recreation|fall registration)\b/.test(text)) {
    return 'toronto_rec';
  }

  return null;
}

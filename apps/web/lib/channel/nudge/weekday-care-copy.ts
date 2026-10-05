import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';

/**
 * The weekday-finder ask's SHAPE. Age and stage choose which prompt a household
 * hears; they never decide whether a family may be asked. A verified school break
 * is the only path that may name a PA day or a break.
 *
 * The sentences themselves are no longer here (VIL-413 / VIL-417): the model writes
 * the ask from this shape through the proactive-voice skill (./proactive-line.ts),
 * and nothing templated stands in when it cannot.
 */

export type WeekdaySearchPrompt = 'after_school' | 'weekend_fallback' | 'break';

export type WeekdayFinderAsk =
  | { prompt: 'after_school_named'; childId: string; name: string }
  | { prompt: 'after_school_household' }
  | { prompt: 'verified_break'; eventKey: string; label: string }
  | { prompt: 'weekend_fallback' };

/**
 * The longest name or break label a one-text ask can carry word for word and still
 * leave the model room to say anything around it.
 */
export const MAX_ASK_NAME_CHARS = 40;

/** A school-age given name this ask may print. Null means use the household sentence. */
export function printableWeekdayName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return isPrintableGsm7Basic(trimmed) ? trimmed : null;
}

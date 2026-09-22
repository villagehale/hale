import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';

/**
 * Parent-facing weekday-finder asks. Design lock (Sloane, 2026-09-21 21:22 ET).
 *
 * The three strings below are byte-stable. Do not paraphrase them. Age and stage
 * choose WHICH of them to send; they never decide whether a family may be asked.
 * A verified school break is the only path that may name a PA day or a break.
 */

/** School-age, under 13, one child whose name SMS can spell. */
export const WEEKDAY_AFTER_SCHOOL_FOR_MAYA =
  'Want me to find one good after-school option for Maya too?';

/** Teen household, or a school-age child whose name cannot be spelled in GSM-7. */
export const WEEKDAY_AFTER_SCHOOL_NEARBY =
  'Want me to find one good after-school option nearby too?';

/** Verified PA day only. Same shape, with the verified event's own name, for a break. */
export const WEEKDAY_PA_DAY_ASK = "There's a PA day coming up. Want me to find something nearby?";

/**
 * Fallback after a real weekend-options send when school-stage context is unknown,
 * mixed, or not applicable (toddler, preschool, no enrollment source).
 */
export const WEEKDAY_WEEKEND_FALLBACK =
  'Those are weekend options. Want me to find something for weekdays too?';

export type WeekdaySearchPrompt = 'after_school' | 'weekend_fallback' | 'break';

export type WeekdayFinderAsk =
  | { prompt: 'after_school_named'; childId: string; name: string }
  | { prompt: 'after_school_household' }
  | { prompt: 'verified_break'; eventKey: string; label: string }
  | { prompt: 'weekend_fallback' };

export function weekdayAfterSchoolNamed(name: string): string {
  return `Want me to find one good after-school option for ${name} too?`;
}

/** Same shape as {@link WEEKDAY_PA_DAY_ASK}. `label` is the verified event's name. */
export function weekdayVerifiedBreakAsk(label: string): string {
  return `There's a ${label} coming up. Want me to find something nearby?`;
}

export function renderWeekdayFinderAsk(ask: WeekdayFinderAsk): string {
  switch (ask.prompt) {
    case 'after_school_named':
      return weekdayAfterSchoolNamed(ask.name);
    case 'after_school_household':
      return WEEKDAY_AFTER_SCHOOL_NEARBY;
    case 'verified_break':
      return weekdayVerifiedBreakAsk(ask.label);
    case 'weekend_fallback':
      return WEEKDAY_WEEKEND_FALLBACK;
  }
}

/** A school-age given name this ask may print. Null means use the household sentence. */
export function printableWeekdayName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return isPrintableGsm7Basic(trimmed) ? trimmed : null;
}

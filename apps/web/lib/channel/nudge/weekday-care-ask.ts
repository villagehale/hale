import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';

/**
 * Which weekday-care question the decider is holding. The sentences used to
 * live beside these types. They are gone: the writer speaks, and a missing
 * model sends nothing.
 */

export type WeekdaySearchPrompt = 'after_school' | 'weekend_fallback' | 'break';

export type WeekdayFinderAsk =
  | { prompt: 'after_school_named'; childId: string; name: string }
  | { prompt: 'after_school_household' }
  | { prompt: 'verified_break'; eventKey: string; label: string }
  | { prompt: 'weekend_fallback' };

/** A school-age given name this ask may print. Null means the household ask. */
export function printableWeekdayName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return isPrintableGsm7Basic(trimmed) ? trimmed : null;
}

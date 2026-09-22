/**
 * THE ASK'S DEDUPE KEY, minted and parsed in one place.
 *
 * The weekday-care question names ONE child, and the answer is filed against that
 * child — but the parent's words rarely say who ("she's home with me" names nobody).
 * So the subject comes from the key of the message that asked, exactly the way the
 * health nudge's told-marker is parsed back out of its own key.
 *
 * FIXED ARITY, and that is the whole safety property: the key is five colon-separated
 * parts and a parse that finds anything else returns null rather than guessing which
 * segment was the child. Both directions live here so a change to the shape cannot
 * change the sender without changing the reader.
 */

import { proactiveNudgeTemplateKey } from '~/lib/channel/nudge/shell';
import type { WeekdayFinderAsk, WeekdaySearchPrompt } from '~/lib/channel/nudge/weekday-care-copy';

const PREFIX = 'nudge';
const KIND = 'weekday_care';
const PARTS = 5;

/** Not a child id. A household-scoped ask files no care fact against this token. */
export const WEEKDAY_HOUSEHOLD_SUBJECT = 'household';

export function weekdayCareDedupeKey(
  familyId: string,
  childId: string,
  parentUserId: string,
): string {
  return `${PREFIX}:${familyId}:${KIND}:${childId}:${parentUserId}`;
}

/** The child this key asked about, or null when the key is not a legacy care ask.
 * `household` is a search ask, not a child, and must not be filed as one. */
export function childIdFromWeekdayCareKey(key: string | null): string | null {
  const parsed = parseWeekdayAskKey(key);
  if (parsed === null || parsed.scope !== 'legacy_care') return null;
  return parsed.childId;
}

export function weekdayFinderDedupeKey(
  familyId: string,
  ask: WeekdayFinderAsk,
  parentUserId: string,
): string {
  switch (ask.prompt) {
    case 'weekend_fallback':
      return `${PREFIX}:${familyId}:${KIND}:${WEEKDAY_HOUSEHOLD_SUBJECT}:${parentUserId}`;
    case 'after_school_named':
      return `${PREFIX}:${familyId}:weekday_after_school:${ask.childId}:${parentUserId}`;
    case 'after_school_household':
      return `${PREFIX}:${familyId}:weekday_after_school:${WEEKDAY_HOUSEHOLD_SUBJECT}:${parentUserId}`;
    case 'verified_break':
      return `${PREFIX}:${familyId}:weekday_break:${ask.eventKey}:${parentUserId}`;
  }
}

export function weekdayFinderTemplateKey(ask: WeekdayFinderAsk): string {
  switch (ask.prompt) {
    case 'weekend_fallback':
      return proactiveNudgeTemplateKey('weekday_care');
    case 'after_school_named':
    case 'after_school_household':
      return proactiveNudgeTemplateKey('weekday_after_school');
    case 'verified_break':
      return proactiveNudgeTemplateKey('weekday_break');
  }
}

export type ParsedWeekdayAskKey =
  | { scope: 'legacy_care'; childId: string }
  | { scope: 'search'; prompt: WeekdaySearchPrompt; eventKey: string | null };

/** Five colon-separated parts, or null. A search ask is not a child id. */
export function parseWeekdayAskKey(key: string | null): ParsedWeekdayAskKey | null {
  if (key === null) return null;
  const parts = key.split(':');
  if (parts.length !== PARTS) return null;
  if (parts[0] !== PREFIX) return null;
  const kind = parts[2];
  const subject = parts[3];
  if (subject === undefined || subject.length === 0) return null;
  if (kind === KIND) {
    if (subject === WEEKDAY_HOUSEHOLD_SUBJECT) {
      return { scope: 'search', prompt: 'weekend_fallback', eventKey: null };
    }
    return { scope: 'legacy_care', childId: subject };
  }
  if (kind === 'weekday_after_school') {
    return { scope: 'search', prompt: 'after_school', eventKey: null };
  }
  if (kind === 'weekday_break') {
    return { scope: 'search', prompt: 'break', eventKey: subject };
  }
  return null;
}

/** The verified-break event key carried in a break ask's dedupe key. */
export function eventKeyFromWeekdayBreakDedupe(key: string | null): string | null {
  const parsed = parseWeekdayAskKey(key);
  if (parsed === null || parsed.scope !== 'search' || parsed.prompt !== 'break') return null;
  return parsed.eventKey;
}

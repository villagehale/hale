import type { ReplyLanguage } from '../language';
import { NO_BOOKING_CLAIM } from '../linq/group-line-input';
import type { SpokenLineInput } from '../voice/judge';

/**
 * VIL-413 / VIL-417. What the model is handed for the proactive asks Hale texts
 * ONE parent in their own thread: an open Saturday, and the weekday-care finder
 * ask. Until this change both were byte-locked sentences; now code supplies the
 * kid, the day, the break label, and the judge holds the limits.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx so
 * the real request shape is judged, not a replica.
 */

export const PROACTIVE_VOICE_SKILL = 'proactive-voice';

/** Single-segment GSM-7 is 160; the judge leaves room for a French accent or two. */
const PROACTIVE_MAX_CHARS = 200;

/**
 * Same shape the weekday-care decide produces (nudge-decide.ts). It is repeated here
 * rather than imported so this module stays loadable without `~/` (see above).
 */
export type ProactiveWeekdayAsk =
  | { prompt: 'after_school_named'; childId: string; name: string }
  | { prompt: 'after_school_household' }
  | { prompt: 'verified_break'; eventKey: string; label: string }
  | { prompt: 'weekend_fallback' };

export type ProactiveLineRequest =
  | { kind: 'empty_saturday'; kid: string }
  | { kind: 'weekday_care'; ask: ProactiveWeekdayAsk };

export type ProactiveLineKind = ProactiveLineRequest['kind'];

/**
 * Facts, limits, and anchors for one ask. The model sees facts; the judge sees the rest.
 * `address` is tu in a parent's own thread and vous when the ask lands in the household
 * group (the weekday ask has no group-voice twin, so the 1:1 skill speaks there too).
 */
export function proactiveLineInput(
  request: ProactiveLineRequest,
  language: ReplyLanguage,
  address: 'tu' | 'vous' = 'tu',
): SpokenLineInput {
  const base = {
    skill: PROACTIVE_VOICE_SKILL,
    kind: request.kind,
    language,
    address,
    questions: 1 as const,
    maxChars: PROACTIVE_MAX_CHARS,
    forbidden: [NO_BOOKING_CLAIM],
  };
  switch (request.kind) {
    case 'empty_saturday': {
      // The day is a fact the model must be handed, or the judge would refuse the
      // only weekday this line exists to name.
      const day = language === 'fr' ? 'samedi' : 'Saturday';
      return {
        ...base,
        facts: { kid: request.kid, day },
        mustMention: [request.kid, day],
      };
    }
    case 'weekday_care': {
      const ask = request.ask;
      switch (ask.prompt) {
        case 'after_school_named':
          return {
            ...base,
            facts: { prompt: 'after_school', kid: ask.name },
            mustMention: [ask.name],
          };
        case 'after_school_household':
          return { ...base, facts: { prompt: 'after_school', kid: null } };
        case 'verified_break':
          return {
            ...base,
            facts: { prompt: 'break', label: ask.label },
            mustMention: [ask.label],
          };
        case 'weekend_fallback':
          return { ...base, facts: { prompt: 'weekend_fallback' } };
      }
    }
  }
}

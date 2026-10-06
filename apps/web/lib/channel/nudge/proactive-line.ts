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
 * The travel opening shares a four-segment brief with two venue names, two schedules,
 * two prices and the provenance line (lib/travel/copy.ts), so it gets one short clause.
 */
export const TRAVEL_OPENING_MAX_CHARS = 110;

/**
 * The opening leads INTO the finds; it must not be one. A museum, a zoo or a pool named
 * here is a place the brief's own picks did not supply, and the brief's fact-lint cannot
 * subtract it. Words that sit inside real city names (park, beach) are left out: the
 * judge tests the whole line, and "Long Beach" is a city.
 */
export const NO_TRAVEL_FIND = {
  name: 'travel_find',
  pattern:
    /\b(?:museum|zoo|aquarium|pool|playground|library|theat(?:re|er)|mus[ée]e|piscine|plage|biblioth[èe]que)\b/i,
};

/**
 * Same shape the weekday-care decide produces (nudge-decide.ts). It is repeated here
 * rather than imported so this module stays loadable without `~/` (see above).
 */
export type ProactiveWeekdayAsk =
  | { prompt: 'after_school_named'; childId: string; name: string }
  | { prompt: 'after_school_household' }
  | { prompt: 'verified_break'; eventKey: string; label: string }
  | { prompt: 'weekend_fallback'; optionsSent?: boolean };

export type ProactiveLineRequest =
  | { kind: 'empty_saturday'; kid: string }
  | { kind: 'weekday_care'; ask: ProactiveWeekdayAsk }
  /**
   * The opening of the travel brief (lib/travel/copy.ts): where the family will be and
   * when, leading into the finds code appends in the source's own words. `days` is the
   * trip's own phrase ("the 12th to the 15th"); `kids` are the under-13s' first names,
   * empty when there are none to name (a teen's absence is indistinguishable from
   * having no children on file).
   */
  | { kind: 'travel_brief'; city: string; days: string; kids: readonly string[] };

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
    case 'travel_brief': {
      // No question: there is no reply handler behind the brief, and a question with
      // nothing behind it is the recorded 2026-08-22 defect. The finds follow the
      // opening, so the line must not name a place or a thing to do of its own.
      const kids = [...request.kids];
      return {
        ...base,
        questions: 0,
        maxChars: TRAVEL_OPENING_MAX_CHARS,
        facts: { city: request.city, days: request.days, kids: kids.length > 0 ? kids : null },
        mustMention: [request.city, request.days, ...kids],
        forbidden: [NO_BOOKING_CLAIM, NO_TRAVEL_FIND],
      };
    }
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
          // `optionsSent` is the only record of a weekend send this round. The
          // decide path sets it when that send happened. A request that does not
          // is nothing found, and the model must not claim a send.
          return {
            ...base,
            facts: { prompt: 'weekend_fallback', optionsSent: ask.optionsSent === true },
          };
      }
    }
  }
}

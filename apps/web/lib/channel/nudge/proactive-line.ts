import type { ReplyLanguage } from '../language';
import { NO_BOOKING_CLAIM } from '../linq/group-line-input';
import type { SpokenLineInput } from '../voice/judge';

/**
 * VIL-413 / VIL-417. What the model is handed for the proactive texts Hale sends
 * ONE parent in their own thread: an open Saturday, the weekday-care finder ask,
 * and the travel brief. Until this change these were byte-locked sentences; now
 * code supplies the kid, the day, the break label, the venues' own words, and the
 * judge holds the limits.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx so
 * the real request shape is judged, not a replica.
 */

export const PROACTIVE_VOICE_SKILL = 'proactive-voice';

/** Single-segment GSM-7 is 160; the judge leaves room for a French accent or two. */
const PROACTIVE_MAX_CHARS = 200;

/**
 * The travel brief is the one proactive text allowed four GSM-7 segments (612 septets,
 * lib/travel/copy.ts): two venue names, two schedules, two prices. The judge's cap is a
 * coarse character count; the exact segment lint runs in the sweep afterwards.
 */
export const TRAVEL_BRIEF_MAX_CHARS = 600;

/** "Ça t'intéresse que je cherche" stuffs the offer inside que. The question does not start that way. */
export const BROKEN_CA_TINTERESSE = {
  name: 'ca_tinteresse_que',
  pattern: /ça t['’]int[ée]resse que\b/i,
};

/**
 * A travel find is off a venue's own page. Nobody has been; nobody recommends. A body
 * that says otherwise is claiming a review Hale does not hold.
 */
/**
 * "Straight from" names the pages and drops the check, even in one sentence.
 * "Both details are straight from" and "Details straight from" are the same failure.
 */
export const STRAIGHT_FROM_BOTH = {
  name: 'straight_from',
  pattern: /straight from/i,
};

export const NO_BEEN_THERE_CLAIM = {
  name: 'been_there_claim',
  pattern:
    /\b(?:i['’]ve been|we['’]ve been|parents? (?:love|loved|recommend|swear by)|families (?:love|loved|recommend)|highly recommended|recommended by|a (?:local )?favou?rite)\b/i,
};

/** One find, in the venue's own words. Null is unpublished, and stays unsaid. */
export interface TravelPickFact {
  name: string;
  when: string | null;
  price: string | null;
}

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
   * The whole travel brief (lib/travel/copy.ts): where the family will be and when, the
   * one or two finds in the venues' own words, and that those words are the venues'.
   * `days` is the trip's own phrase ("the 12th to the 15th"); `kids` are the under-13s'
   * first names, empty when there are none to name (a teen's absence is
   * indistinguishable from having no children on file); `picks` are at most two.
   */
  | {
      kind: 'travel_brief';
      city: string;
      days: string;
      kids: readonly string[];
      picks: readonly TravelPickFact[];
    };

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
      // nothing behind it is the recorded 2026-08-22 defect. Every pick's name, schedule
      // and price must be carried as published: the venue's words are the only facts
      // the body may hold, and the travel lint (lib/travel/copy.ts) refuses any digit
      // that traces to none of them.
      const kids = [...request.kids];
      const picks = request.picks.map((pick) => ({ ...pick }));
      return {
        ...base,
        questions: 0,
        maxChars: TRAVEL_BRIEF_MAX_CHARS,
        facts: {
          city: request.city,
          days: request.days,
          kids: kids.length > 0 ? kids : null,
          picks,
          source: 'the venues own pages',
        },
        mustMention: [
          request.city,
          request.days,
          ...kids,
          ...picks.flatMap((pick) =>
            [pick.name, pick.when, pick.price].filter((v): v is string => v !== null),
          ),
        ],
        forbidden: [NO_BOOKING_CLAIM, NO_BEEN_THERE_CLAIM, STRAIGHT_FROM_BOTH],
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
            forbidden: [NO_BOOKING_CLAIM, BROKEN_CA_TINTERESSE],
          };
      }
    }
  }
}

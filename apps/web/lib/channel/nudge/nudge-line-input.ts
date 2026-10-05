import type { ReplyLanguage } from '../language';
import { NO_BOOKING_CLAIM } from '../linq/group-line-input';
import type { SpokenLineInput } from '../voice/judge';

/**
 * VIL-413 / VIL-417. What the model is handed for the three proactive FINDS the nudge
 * sweep sends — a registration window, a weekend weather swap, a weekday drop-in.
 * The decision object has already been reduced to facts (nudge-voice.ts
 * `nudgeVoiceContext`): no candidate uuid, no window id, no municipality token.
 * There is no deterministic sentence underneath any of these any more.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx so the
 * real request shape is judged, not a replica.
 */

export const NUDGE_VOICE_SKILL = 'nudge-voice';

/** The skill's own ceiling: "Under 220 characters all in." */
const NUDGE_MAX_CHARS = 220;

export interface RegistrationLineFacts {
  kind: 'registration';
  town: string;
  cycle: string;
  /** The ONLY time-shaped fact. */
  opensAtLocal: string;
  kidNames: readonly string[];
  residentNote: string | null;
  ageApproximate: boolean;
}

export interface WeatherSwapLineFacts {
  kind: 'weather_swap';
  what: string;
  where: string | null;
  /** `saturday` or `sunday`, lower case, as the decide emits it. */
  day: string;
  kidNames: readonly string[];
  weatherFact: string;
  whyFacts: readonly string[];
}

export interface WeekdayDropInLineFacts {
  kind: 'weekday_dropin';
  what: string;
  where: string | null;
  /** One weekday, lower case, as the decide emits it. */
  day: string;
  kidNames: readonly string[];
}

export type NudgeLineFacts = RegistrationLineFacts | WeatherSwapLineFacts | WeekdayDropInLineFacts;

const FRENCH_DAY: Record<string, string> = {
  monday: 'lundi',
  tuesday: 'mardi',
  wednesday: 'mercredi',
  thursday: 'jeudi',
  friday: 'vendredi',
  saturday: 'samedi',
  sunday: 'dimanche',
};

/** The day in the language the line is written in: the judge refuses any weekday the facts did not name. */
export function nudgeDayLabel(day: string, language: ReplyLanguage): string {
  if (language === 'fr') return FRENCH_DAY[day.toLowerCase()] ?? day;
  return day;
}

/** The nudge is an offer, never a request for an answer, and never urgency Hale was not given. */
export const NO_INVENTED_URGENCY = {
  name: 'invented_urgency',
  pattern:
    /spots? fill|fills? (?:up )?fast|don'?t miss|hurry|last chance|places? limit[ée]es?|d[ée]p[êe]che|vite avant/i,
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * Facts, limits, and anchors for one find. The model sees facts; the judge sees the
 * rest. `address` is tu in a parent's own thread and vous in the household group.
 */
export function nudgeLineInput(
  facts: NudgeLineFacts,
  language: ReplyLanguage,
  address: 'tu' | 'vous' = 'tu',
): SpokenLineInput {
  const base = {
    skill: NUDGE_VOICE_SKILL,
    kind: facts.kind,
    language,
    address,
    questions: 0 as const,
    maxChars: NUDGE_MAX_CHARS,
    forbidden: [NO_BOOKING_CLAIM, NO_INVENTED_URGENCY],
  };
  switch (facts.kind) {
    case 'registration':
      return {
        ...base,
        facts: {
          town: facts.town,
          cycle: facts.cycle,
          opensAtLocal: facts.opensAtLocal,
          kidNames: facts.kidNames,
          residentNote: facts.residentNote,
          ageApproximate: facts.ageApproximate,
        },
        mustMention: unique([facts.town, ...facts.kidNames]),
      };
    case 'weather_swap': {
      const day = nudgeDayLabel(facts.day, language);
      return {
        ...base,
        facts: {
          what: facts.what,
          where: facts.where,
          day,
          kidNames: facts.kidNames,
          weatherFact: facts.weatherFact,
          whyFacts: facts.whyFacts,
        },
        mustMention: unique([facts.what, day, ...facts.kidNames]),
      };
    }
    case 'weekday_dropin': {
      const day = nudgeDayLabel(facts.day, language);
      return {
        ...base,
        facts: { what: facts.what, where: facts.where, day, kidNames: facts.kidNames },
        mustMention: unique([facts.what, day, ...facts.kidNames]),
      };
    }
  }
}

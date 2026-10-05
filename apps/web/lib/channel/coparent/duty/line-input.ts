import { NO_KEYWORD_ASK } from '../../checkin/line-input';
import { NO_BOOKING_CLAIM } from '../../linq/group-line-input';
import type { SpokenLineInput } from '../../voice/judge';

/**
 * VIL-413 / VIL-417 · what the model is handed for every word the duty lane says in a
 * household group: the Sunday week overview, the night-before reminder, the two-day
 * re-ask, the answer to "who's got pickup", the which-kid and both-claimed questions, and
 * the hand-off to the parent who has not said.
 *
 * Until this change the lane was nineteen locked templates in two languages (`DUTY_*_COPY`
 * in copy.ts) with a model rewrite layered over them that fell back to the template on any
 * miss. All of it is gone. Code supplies the facts — the names a parent agreed to, the
 * kid, the event as the calendar titles it, the day and clock as words — the judge holds
 * the limits, and the skill (packages/agent/skills/duty-voice.md) holds the direction.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx so the real
 * request shape is judged, not a replica.
 */

export const DUTY_VOICE_SKILL = 'duty-voice';

/** One or two short sentences, with room for French accents and two first names. */
export const DUTY_MAX_CHARS = 240;

/** The week overview carries up to {@link DUTY_OVERVIEW_MAX_ENTRIES} entries. */
export const DUTY_OVERVIEW_MAX_CHARS = 480;

/**
 * The most entries one overview carries. A busier week is cut here, earliest first, so a
 * household never gets an overview the judge would refuse for length (and then nothing).
 */
export const DUTY_OVERVIEW_MAX_ENTRIES = 6;

export interface DutyWeekEntry {
  /** A weekday as a word, in the household's language. */
  day: string;
  /** The event as the calendar titles it, less the kid's name. */
  event: string;
  /** A parent's first name — set only when a parent said who has it. Calendar presence is not enough. */
  owner: string | null;
}

export type DutyLineRequest =
  | { kind: 'week_overview'; entries: readonly DutyWeekEntry[] }
  | { kind: 'reask'; kid: string; event: string; day: string; time: string }
  | { kind: 'night_before'; owner: string; kid: string; event: string; time: string }
  | {
      kind: 'owner';
      owner: string;
      kid: string;
      event: string;
      day: string;
      time: string;
      /** True when Hale just wrote this down from what the parent said, and is confirming it back. */
      recorded: boolean;
    }
  | { kind: 'nobody_yet'; kid: string; event: string; day: string; time: string }
  | { kind: 'which_kid'; name: string; kids: readonly string[] }
  | { kind: 'both_claimed'; event: string; day: string; parentA: string; parentB: string }
  | { kind: 'silent_parent'; name: string; event: string; day: string };

export type DutyLineKind = DutyLineRequest['kind'];

/**
 * The lane's own red line: no scoreboard. Who has done more is never said, and the
 * judge cannot know that from the facts alone.
 */
export const NO_SCOREKEEPING = {
  name: 'scorekeeping',
  pattern:
    /\b(?:your turn|again this week|as usual|more than|fair share|keeping score|keep score|à ton tour|à votre tour|encore une fois|comme d'habitude|plus que)\b/iu,
};

/** Hale does not go anywhere itself. */
export const NO_HALE_DRIVES = {
  name: 'hale_drives',
  pattern:
    /\b(?:i(?:'ll| will)? (?:drive|take (?:him|her|them|the kids)|pick (?:him|her|them) up|drop (?:him|her|them) off)|je (?:vais )?(?:conduire|les? (?:emmener|chercher|déposer)))\b/iu,
};

/** The entries an overview is handed: this week's first {@link DUTY_OVERVIEW_MAX_ENTRIES}. */
export function overviewEntries(entries: readonly DutyWeekEntry[]): DutyWeekEntry[] {
  return entries.slice(0, DUTY_OVERVIEW_MAX_ENTRIES).map((entry) => ({ ...entry }));
}

/**
 * Facts, limits and anchors for one duty line. Every line lands in the household group,
 * so `address` is vous — except the two moments addressed to one parent by name
 * (which_kid, silent_parent), which are tu.
 */
export function dutyLineInput(request: DutyLineRequest, language: 'en' | 'fr'): SpokenLineInput {
  const base = {
    skill: DUTY_VOICE_SKILL,
    kind: request.kind,
    language,
    address: 'vous' as const,
    maxChars: DUTY_MAX_CHARS,
    forbidden: [NO_KEYWORD_ASK, NO_BOOKING_CLAIM, NO_SCOREKEEPING, NO_HALE_DRIVES],
  };
  switch (request.kind) {
    case 'week_overview': {
      const entries = overviewEntries(request.entries);
      return {
        ...base,
        questions: 0,
        maxChars: DUTY_OVERVIEW_MAX_CHARS,
        facts: {
          entries: entries.map((entry) => ({
            day: entry.day,
            event: entry.event,
            owner: entry.owner,
          })),
        },
        mustMention: entries.flatMap((entry) =>
          [entry.day, entry.event, entry.owner].filter((v): v is string => v !== null),
        ),
      };
    }
    case 'reask':
      return {
        ...base,
        questions: 1,
        facts: { kid: request.kid, event: request.event, day: request.day, time: request.time },
        mustMention: [request.kid, request.event, request.day, request.time],
      };
    case 'night_before':
      return {
        ...base,
        questions: 0,
        facts: {
          owner: request.owner,
          kid: request.kid,
          event: request.event,
          time: request.time,
        },
        mustMention: [request.owner, request.kid, request.event, request.time],
      };
    case 'owner':
      return {
        ...base,
        questions: 0,
        facts: {
          owner: request.owner,
          kid: request.kid,
          event: request.event,
          day: request.day,
          time: request.time,
          recorded: request.recorded,
        },
        mustMention: [request.owner, request.kid, request.event, request.day, request.time],
      };
    case 'nobody_yet':
      return {
        ...base,
        questions: 1,
        facts: { kid: request.kid, event: request.event, day: request.day, time: request.time },
        mustMention: [request.kid, request.event, request.day, request.time],
      };
    case 'which_kid': {
      const kids = [...request.kids];
      return {
        ...base,
        address: 'tu',
        questions: 1,
        facts: { name: request.name, kids },
        mustMention: [request.name, ...kids],
      };
    }
    case 'both_claimed':
      return {
        ...base,
        questions: 1,
        facts: {
          event: request.event,
          day: request.day,
          parentA: request.parentA,
          parentB: request.parentB,
        },
        mustMention: [request.event, request.day, request.parentA, request.parentB],
      };
    case 'silent_parent':
      return {
        ...base,
        address: 'tu',
        questions: 0,
        facts: { name: request.name, event: request.event, day: request.day },
        mustMention: [request.name, request.event, request.day],
      };
  }
}

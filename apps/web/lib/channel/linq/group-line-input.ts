import type { ReplyLanguage } from '../language';
import { frenchAddress } from '../voice/address';
import type { SpokenLineInput, SpokenTurn } from '../voice/judge';

/**
 * VIL-413 / VIL-417. What the model is handed for each line Hale says in the
 * Linq household group: the facts, what it must carry, how many questions it
 * may ask, and which red lines code holds. Hale never says it booked,
 * registered, or reserved anything, because it did not. A line both parents
 * read is vous. A line to one parent uses the family's stored register, or tu.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx
 * so the real request shape is what gets judged, not a replica.
 */

export const GROUP_VOICE_SKILL = 'group-voice';

/** About two or three lines. A link note and a Google heads-up are each a bubble. */
export const BUBBLE_MAX_CHARS = 220;

export type GroupLineKind =
  | 'welcome'
  | 'member_welcome'
  | 'stranger_hold'
  | 'name_ack'
  | 'calendar_ask'
  | 'calendar_link'
  | 'calendar_heads_up'
  | 'calendar_receipt'
  | 'gmail_ask'
  | 'gmail_receipt'
  | 'kid_event'
  | 'conflict'
  | 'who_takes'
  | 'handoff'
  | 'how_it_went'
  | 'both_free'
  | 'decision_sync'
  | 'departure'
  | 'empty_saturday';

export interface GroupKidEventFact {
  parent: string;
  kid: string;
  event: string;
  day: string;
  time: string;
}

export interface GroupDecisionFact {
  /** The parent who decided, or null when their name is not stored. */
  parent: string | null;
  /** `duty` is a parent saying they will take an event. */
  decision: 'picked' | 'passed' | 'duty';
  activity: string;
  kid: string;
  day: string | null;
  time: string | null;
}

export type GroupLineRequest =
  | { kind: 'welcome' }
  | { kind: 'member_welcome'; adder: string | null }
  | { kind: 'stranger_hold'; parentA: string }
  | { kind: 'name_ack'; name: string }
  | { kind: 'calendar_ask'; name: string; address?: 'tu' | 'vous' }
  | { kind: 'calendar_link'; name: string; address?: 'tu' | 'vous' }
  | { kind: 'calendar_heads_up'; name: string; address?: 'tu' | 'vous' }
  | { kind: 'calendar_receipt'; name: string }
  | { kind: 'gmail_ask'; name: string; address?: 'tu' | 'vous' }
  | { kind: 'gmail_receipt'; name: string }
  | { kind: 'kid_event'; events: readonly GroupKidEventFact[] }
  | { kind: 'conflict'; kid: string; event: string; day: string; time: string }
  | { kind: 'who_takes'; kid: string; event: string; day: string; time: string }
  | { kind: 'handoff'; name: string; kid: string; event: string; time: string }
  | { kind: 'how_it_went'; name: string | null; activity: string }
  | { kind: 'both_free'; slots: readonly [string, string] }
  | { kind: 'decision_sync'; decisions: readonly GroupDecisionFact[] }
  | { kind: 'departure'; name: string | null; address?: 'tu' | 'vous'; remaining?: number }
  | { kind: 'empty_saturday'; name: string | null; kid: string };

/** Hale recommends and prepares. It never claims it booked. */
export const NO_BOOKING_CLAIM = {
  name: 'booking_claim',
  pattern:
    /\b(?:i(?:'ve| have)? (?:booked|registered|reserved|signed (?:him|her|them|you) up)|j'ai (?:r[ée]serv[ée]|inscrit)|c'est (?:r[ée]serv[ée]|inscrit))\b/i,
};

/** An internal name. It does not belong in a line a parent reads. */
export const KIDS_YEAR_CLAIM = {
  name: 'kids_year',
  pattern: /kids['’] year|l['’]ann[ée]e des enfants|l['’]annee des enfants/i,
};

/** "You both" is a count. It is refused unless two people remain. */
export const BOTH_WHEN_NOT_TWO = {
  name: 'both',
  pattern: /\byou both\b|\byou two\b|vous deux/i,
};

/** Coaching a parent past Google's warning. The heads-up names the screen and stops. */
export const GOOGLE_COACHING = {
  name: 'google_coaching',
  pattern: /tap advanced|carry on|it(?:'|’)s safe|paramètres avancés/i,
};

/** Hale speaks as itself. "we" is a company, and it fails. */
export const NO_WE_FOR_HALE = {
  name: 'we_for_hale',
  pattern: /\bwe(?:'re|'ll|’re|’ll)?\b/i,
};

/** "No worries" right after "not verified" reads as "it's safe". */
export const NO_SOFT_SAFE = {
  name: 'soft_safe',
  pattern: /no worries|pas de souci|aucun souci/i,
};

/** A departure is a fact. "Moving on" and "s'en va" read like a breakup. */
export const NO_BREAKUP = {
  name: 'breakup',
  pattern: /moving on|s['’]en va/i,
};

/**
 * Connecting a calendar does two things: kids' events can show on it, or Hale can
 * see what's already there for reminders. Sync, and keeping things straight between
 * two people, are a two-way claim this ask does not get to make.
 */
export const CALENDAR_SYNC_CLAIM = {
  name: 'calendar_sync',
  pattern:
    /\bsync\w*\b|keep\s+(?:the\s+kids['’]\s+|their\s+)?things\s+straight|between the two of you|two-way|two way|bidirectionn?el|garder les choses|en ordre entre/i,
};

const GOOGLE_HEADS_UP_FORBIDDEN = [GOOGLE_COACHING, NO_WE_FOR_HALE, NO_SOFT_SAFE];

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/** Facts, limits, and anchors for one kind. The model sees facts; the judge sees the rest. */
export function groupLineInput(
  request: GroupLineRequest,
  language: ReplyLanguage,
  extra: { parentWords?: string | null; recentTurns?: readonly SpokenTurn[] } = {},
): SpokenLineInput {
  const line = groupLineFields(request, language, extra);
  return { ...line, forbidden: [KIDS_YEAR_CLAIM, ...(line.forbidden ?? [])] };
}

function groupLineFields(
  request: GroupLineRequest,
  language: ReplyLanguage,
  extra: { parentWords?: string | null; recentTurns?: readonly SpokenTurn[] } = {},
): SpokenLineInput {
  const base = {
    skill: GROUP_VOICE_SKILL,
    kind: request.kind,
    language,
    address: 'vous' as const,
    parentWords: extra.parentWords ?? null,
    recentTurns: extra.recentTurns ?? [],
  };
  switch (request.kind) {
    case 'welcome':
      return { ...base, facts: {}, questions: 1 };
    case 'member_welcome':
      return { ...base, facts: { adder: request.adder }, questions: 1 };
    case 'stranger_hold':
      return {
        ...base,
        facts: { parentA: request.parentA },
        questions: 1,
        mustMention: [request.parentA],
      };
    case 'name_ack':
      return { ...base, facts: { name: request.name }, questions: 0 };
    case 'calendar_ask':
      return {
        ...base,
        address: frenchAddress(request.address),
        facts: { name: request.name },
        questions: 1,
        mustMention: [request.name],
        forbidden: [CALENDAR_SYNC_CLAIM],
      };
    case 'calendar_link':
      return {
        ...base,
        address: frenchAddress(request.address),
        facts: { name: request.name },
        questions: 0,
        mustMention: [request.name],
        linkFollows: true,
        maxChars: BUBBLE_MAX_CHARS,
        forbidden: GOOGLE_HEADS_UP_FORBIDDEN,
      };
    case 'calendar_heads_up':
      return {
        ...base,
        address: frenchAddress(request.address),
        facts: { name: request.name },
        questions: 0,
        maxChars: BUBBLE_MAX_CHARS,
        forbidden: GOOGLE_HEADS_UP_FORBIDDEN,
      };
    case 'gmail_ask':
      return {
        ...base,
        address: frenchAddress(request.address),
        facts: { name: request.name },
        questions: 1,
        mustMention: [request.name],
        linkFollows: true,
        forbidden: GOOGLE_HEADS_UP_FORBIDDEN,
      };
    case 'calendar_receipt':
    case 'gmail_receipt':
      return {
        ...base,
        facts: { name: request.name },
        questions: 0,
        mustMention: [request.name],
        forbidden: [NO_BOOKING_CLAIM],
      };
    case 'kid_event':
      return {
        ...base,
        facts: { events: request.events.map((event) => ({ ...event })) },
        questions: 0,
        mustMention: unique(
          request.events.flatMap((event) => [event.kid, event.event, event.time]),
        ),
        forbidden: [NO_BOOKING_CLAIM],
        maxChars: 160 + request.events.length * 120,
      };
    case 'conflict':
    case 'who_takes':
      return {
        ...base,
        facts: { kid: request.kid, event: request.event, day: request.day, time: request.time },
        questions: 1,
        mustMention: [request.kid, request.event, request.time],
        forbidden: [NO_BOOKING_CLAIM],
      };
    case 'handoff':
      return {
        ...base,
        facts: {
          name: request.name,
          kid: request.kid,
          event: request.event,
          time: request.time,
          when: language === 'fr' ? 'demain' : 'tomorrow',
        },
        questions: 0,
        mustMention: [request.name, request.kid, request.event, request.time],
        forbidden: [NO_BOOKING_CLAIM],
      };
    case 'how_it_went':
      return {
        ...base,
        facts: { name: request.name, activity: request.activity },
        questions: 1,
        mustMention: unique([request.activity, request.name ?? '']),
        maxChars: 200,
      };
    case 'both_free':
      return {
        ...base,
        facts: { slots: request.slots },
        questions: 1,
        mustMention: [...request.slots],
        forbidden: [NO_BOOKING_CLAIM],
      };
    case 'decision_sync':
      return {
        ...base,
        facts: { decisions: request.decisions.map((decision) => ({ ...decision })) },
        questions: 0,
        mustMention: unique(
          request.decisions.flatMap((decision) => [decision.activity, decision.kid]),
        ),
        forbidden: [NO_BOOKING_CLAIM],
        maxChars: 160 + request.decisions.length * 120,
      };
    case 'departure':
      return {
        ...base,
        address: request.address ?? 'vous',
        facts: { name: request.name, remaining: request.remaining ?? null },
        questions: 0,
        mustMention: request.name ? [request.name] : [],
        forbidden: [NO_BREAKUP, ...(request.remaining === 2 ? [] : [BOTH_WHEN_NOT_TWO])],
      };
    case 'empty_saturday': {
      // The day is a fact the model must be handed, or the judge would refuse the
      // only weekday this line exists to name.
      const day = language === 'fr' ? 'samedi' : 'Saturday';
      return {
        ...base,
        facts: { name: request.name, kid: request.kid, day },
        questions: 1,
        mustMention: unique([request.kid, request.name ?? '', day]),
        forbidden: [NO_BOOKING_CLAIM],
      };
    }
  }
}

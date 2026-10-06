import type { ReplyLanguage } from '../language';
import type { SpokenLineInput } from '../voice/judge';

/**
 * Group onboarding v2 — what the model is handed for one who's-who line.
 *
 * Pure, with relative imports only, so the worker eval
 * (apps/worker/evals/run-group-onboarding-voice-eval.mjs) builds the real request. Code
 * owns every fact: the roster, the names, the roles. The model writes the words. These
 * lines carry Hale's identification and a role vocabulary the household lines in
 * `group-voice` must never say, so they have their own skill.
 */

export const GROUP_ONBOARDING_SKILL = 'group-onboarding-voice';

export type RoleWordKey = 'mom' | 'dad' | 'parent' | 'grandparent' | 'nanny' | 'babysitter';

export type ConnectProviderWord = 'Google Calendar' | 'Gmail';

export type GroupQuietReason = 'unconfirmed' | 'not_family' | 'stopped';

export type GroupOnboardingRequest =
  | { kind: 'roster_ask'; knownParentName: string | null; rosterSize: number }
  | { kind: 'member_ask'; knownParentName: string | null }
  | { kind: 'role_reask' }
  | { kind: 'role_confirmed'; name: string | null; role: RoleWordKey }
  | { kind: 'no_family_yet' }
  | {
      kind: 'connect_link_1to1';
      name: string | null;
      knownParentName: string | null;
      providers: readonly ConnectProviderWord[];
    }
  | { kind: 'text_me_directly'; name: string | null }
  | { kind: 'group_quiet_notice'; reason: GroupQuietReason; count: number }
  | { kind: 'stop_ack' };

export type GroupOnboardingKind = GroupOnboardingRequest['kind'];

const ROLE_WORD: Record<ReplyLanguage, Record<RoleWordKey | 'not_family', string>> = {
  en: {
    mom: 'mom',
    dad: 'dad',
    parent: 'parent',
    grandparent: 'grandparent',
    nanny: 'nanny',
    babysitter: 'babysitter',
    not_family: 'not family',
  },
  fr: {
    mom: 'maman',
    dad: 'papa',
    parent: 'parent',
    grandparent: 'grand-parent',
    nanny: 'nounou',
    babysitter: 'gardienne',
    not_family: 'pas de la famille',
  },
};

/** The choices an ask offers, in the order a person would read them. */
export function roleWords(language: ReplyLanguage): string[] {
  const words = ROLE_WORD[language];
  return [words.mom, words.dad, words.grandparent, words.nanny, words.babysitter, words.not_family];
}

const CONNECTOR_WORD = {
  name: 'connector_word',
  pattern: /\b(?:calendars?|calendriers?|gmail|inbox|courriels?|e-?mails?)\b/i,
};

const BOOKING_CLAIM = {
  name: 'booking_claim',
  pattern:
    /\b(?:booked|registered|reserved|signed (?:you|them|him|her) up|j'ai (?:réservé|inscrit))\b/i,
};

const ROLE_EN = '(?:mom|mum|dad|parent|grand(?:parent|ma|pa|mother|father)|nanny|babysitter|sitter)';
const ROLE_FR = '(?:maman|papa|parent|grand-(?:parent|mère|père)|nounou|gardienne)';
const DET_EN = '(?:the |a |an )?';
const DET_FR = "(?:la |le |l['’]|un |une )?";

/**
 * "Mom or dad?" asks; "you're the dad" tells someone who they are, which only they say.
 * "You're the mom, dad, grandparent, ... or not family?" — a role followed by another role
 * — is the choice list, so it is not an assertion.
 */
const ROLE_ASSERTED = {
  name: 'role_asserted',
  pattern: new RegExp(
    `\\byou(?:['’]re| are) ${DET_EN}${ROLE_EN}\\b(?!,? (?:or )?${DET_EN}${ROLE_EN}\\b)` +
      `|\\bvous êtes ${DET_FR}${ROLE_FR}\\b(?!,? (?:ou )?${DET_FR}${ROLE_FR}\\b)`,
    'i',
  ),
};

const ASK_FORBIDDEN = [CONNECTOR_WORD, BOOKING_CLAIM, ROLE_ASSERTED] as const;
const LINE_FORBIDDEN = [CONNECTOR_WORD, BOOKING_CLAIM] as const;
/** The 1:1 link message says what the links connect; it still never claims a booking. */
const ONE_TO_ONE_FORBIDDEN = [BOOKING_CLAIM, ROLE_ASSERTED] as const;

function named(...values: ReadonlyArray<string | null>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function groupOnboardingLineInput(
  request: GroupOnboardingRequest,
  language: ReplyLanguage,
  options: { parentWords?: string | null } = {},
): SpokenLineInput {
  const base = {
    skill: GROUP_ONBOARDING_SKILL,
    kind: request.kind,
    language,
    address: 'vous' as const,
    parentWords: options.parentWords ?? null,
  };
  const words = roleWords(language);
  switch (request.kind) {
    case 'roster_ask':
      return {
        ...base,
        facts: {
          knownParentName: request.knownParentName,
          rosterSize: request.rosterSize,
          roleWords: words,
        },
        questions: 1,
        mustMention: ['Hale', ...named(request.knownParentName), ...words],
        forbidden: ASK_FORBIDDEN,
      };
    case 'member_ask':
      return {
        ...base,
        facts: { knownParentName: request.knownParentName, roleWords: words },
        questions: 1,
        mustMention: ['Hale', ...named(request.knownParentName), ...words],
        forbidden: ASK_FORBIDDEN,
      };
    case 'role_reask':
      return {
        ...base,
        facts: { roleWords: words },
        questions: 1,
        mustMention: words,
        forbidden: ASK_FORBIDDEN,
      };
    case 'role_confirmed': {
      const roleWord = ROLE_WORD[language][request.role];
      return {
        ...base,
        facts: { name: request.name, roleWord },
        questions: 0,
        mustMention: [...named(request.name), roleWord],
        forbidden: LINE_FORBIDDEN,
      };
    }
    case 'no_family_yet':
      return {
        ...base,
        facts: {},
        questions: 0,
        mustMention: ['Hale'],
        forbidden: LINE_FORBIDDEN,
      };
    case 'connect_link_1to1':
      return {
        ...base,
        address: 'tu',
        facts: {
          name: request.name,
          knownParentName: request.knownParentName,
          providers: [...request.providers],
        },
        questions: 0,
        mustMention: ['Hale', ...named(request.name, request.knownParentName), 'STOP'],
        linkFollows: true,
        wayOut: true,
        forbidden: ONE_TO_ONE_FORBIDDEN,
      };
    case 'text_me_directly':
      return {
        ...base,
        facts: { name: request.name },
        questions: 0,
        mustMention: ['Hale', ...named(request.name)],
        forbidden: LINE_FORBIDDEN,
      };
    case 'group_quiet_notice':
      return {
        ...base,
        address: 'tu',
        facts: { reason: request.reason, count: request.count },
        questions: 0,
        forbidden: LINE_FORBIDDEN,
      };
    case 'stop_ack':
      return {
        ...base,
        facts: {},
        questions: 0,
        wayOut: true,
        forbidden: LINE_FORBIDDEN,
      };
  }
}

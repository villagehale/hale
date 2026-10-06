import type { ReplyLanguage } from '../language';

/**
 * Group onboarding v2 — what the model is handed for one who's-who line.
 *
 * Code owns every fact. The model writes the words. An ask does not hand the parent a
 * list of words to reply with: the reading skill infers the role from whatever they say.
 */

export const GROUP_ONBOARDING_SKILL = 'group-onboarding-voice';

export type RoleWordKey =
  | 'mom'
  | 'dad'
  | 'parent'
  | 'grandparent'
  | 'nanny'
  | 'babysitter'
  | 'aunt'
  | 'uncle'
  | 'cousin'
  | 'family';

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

export interface GroupOnboardingLine {
  skill: typeof GROUP_ONBOARDING_SKILL;
  kind: GroupOnboardingKind;
  language: ReplyLanguage;
  address: 'vous' | 'tu';
  parentWords: string | null;
  facts: Record<string, unknown>;
  questions: 0 | 1;
  mustMention: string[];
  linkFollows?: boolean;
  wayOut?: boolean;
}

const ROLE_WORD: Record<ReplyLanguage, Record<RoleWordKey, string>> = {
  en: {
    mom: 'mom',
    dad: 'dad',
    parent: 'parent',
    grandparent: 'grandparent',
    nanny: 'nanny',
    babysitter: 'babysitter',
    aunt: 'aunt',
    uncle: 'uncle',
    cousin: 'cousin',
    family: 'family',
  },
  fr: {
    mom: 'maman',
    dad: 'papa',
    parent: 'parent',
    grandparent: 'grand-parent',
    nanny: 'nounou',
    babysitter: 'gardienne',
    aunt: 'tante',
    uncle: 'oncle',
    cousin: 'cousin',
    family: 'famille',
  },
};

function named(...values: ReadonlyArray<string | null>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function groupOnboardingLineInput(
  request: GroupOnboardingRequest,
  language: ReplyLanguage,
  options: { parentWords?: string | null } = {},
): GroupOnboardingLine {
  const base: Pick<GroupOnboardingLine, 'skill' | 'kind' | 'language' | 'address' | 'parentWords'> =
    {
      skill: GROUP_ONBOARDING_SKILL,
      kind: request.kind,
      language,
      address: 'vous',
      parentWords: options.parentWords ?? null,
    };
  switch (request.kind) {
    case 'roster_ask':
      return {
        ...base,
        facts: {
          knownParentName: request.knownParentName,
          rosterSize: request.rosterSize,
        },
        questions: 1,
        mustMention: ['Hale', ...named(request.knownParentName)],
      };
    case 'member_ask':
      return {
        ...base,
        facts: { knownParentName: request.knownParentName },
        questions: 1,
        mustMention: ['Hale', ...named(request.knownParentName)],
      };
    case 'role_reask':
      return {
        ...base,
        facts: {},
        questions: 1,
        mustMention: [],
      };
    case 'role_confirmed': {
      const roleWord = ROLE_WORD[language][request.role];
      return {
        ...base,
        facts: { name: request.name, roleWord },
        questions: 0,
        mustMention: [...named(request.name), roleWord],
      };
    }
    case 'no_family_yet':
      return {
        ...base,
        facts: {},
        questions: 0,
        mustMention: ['Hale'],
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
      };
    case 'text_me_directly':
      return {
        ...base,
        facts: { name: request.name },
        questions: 0,
        mustMention: ['Hale', ...named(request.name)],
      };
    case 'group_quiet_notice':
      return {
        ...base,
        address: 'tu',
        facts: { reason: request.reason, count: request.count },
        questions: 0,
        mustMention: [],
      };
    case 'stop_ack':
      return {
        ...base,
        facts: {},
        questions: 0,
        mustMention: [],
        wayOut: true,
      };
  }
}

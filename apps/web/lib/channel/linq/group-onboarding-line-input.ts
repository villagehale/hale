import type { ReplyLanguage } from '../language';

/**
 * Group onboarding v2 — what the model is handed for one who's-who line.
 *
 * Code owns every fact. The model writes the words. An ask does not hand the parent a
 * list of words to reply with: the reading skill infers the role from whatever they say.
 */

export const GROUP_ONBOARDING_SKILL = 'group-onboarding-voice';

/**
 * VIL-727 — the join intro has a skill of its own, so the onboarding lines' prompt (and
 * every recording keyed on it) is unchanged.
 */
export const GROUP_JOIN_INTRO_SKILL = 'group-join-intro';

export type GroupOnboardingSkill = typeof GROUP_ONBOARDING_SKILL | typeof GROUP_JOIN_INTRO_SKILL;

/**
 * VIL-727 — the ground rules a join intro may state, in the order they are said. Code
 * decides which of them are true for the behaviour that ships today
 * ({@link groupJoinIntroClaims}); one that is not true is left out of the list, so the
 * model never hears it and cannot say it.
 */
export const GROUP_JOIN_INTRO_CLAIMS = [
  'reads_this_chat',
  'email_never_shown',
  'speaks_when_called',
  'private_goes_direct',
  'anyone_can_remove',
] as const;

export type GroupJoinIntroClaim = (typeof GROUP_JOIN_INTRO_CLAIMS)[number];

/**
 * Who the intro asks, if anyone: each person who they are in this family (a household
 * group with people Hale has not asked yet), who they are and which kid they are with (a
 * group several families share), or nobody (everyone here is already known).
 */
export type GroupJoinIntroAsk = 'none' | 'who_in_family' | 'who_and_kid';

export type GroupJoinIntroAudience = 'household' | 'shared';

/**
 * Apple lets a member remove someone from a group iMessage only when the group has four
 * or more people, all on Apple devices (support.apple.com/108303). A Linq line is only
 * ever in an iMessage group, and Hale is one of the four, so it takes three other people.
 */
export const MIN_OTHER_PEOPLE_TO_REMOVE_HALE = 3;

/**
 * The claims that are true today, in their fixed order. Pure: the caller reads the flags
 * and counts the people.
 *
 * - `reads_this_chat`: Hale reads every message in a group it is in (the opt-out read, the
 *   turn read and the roster read all see each one).
 * - `email_never_shown`: a group turn never gets mail (VIL-439 drops inbox items and
 *   inbox-built memory before the model runs). The one exception is the provider
 *   time-change notice (`GROUP_MAIL_NOTICE_ENABLED`), which posts a fact read from mail
 *   into the household group, so while it is live the claim is left out.
 * - `speaks_when_called`: a household group is answered only while
 *   `LINQ_GROUP_TURN_AI_ENABLED` is on (addressed, or a question only Hale could answer).
 *   Dark, Hale is silent there and the claim is left out. A shared group's turn is the
 *   model's read whenever that intro can be sent (`LINQ_MULTI_FAMILY_GROUPS_ENABLED`).
 * - `private_goes_direct`: never, at the moment Hale joins. A household group only holds
 *   a line the audience may not hear. A shared group's private aside sends a 1:1 only
 *   after that household has consented for this chat, which joining does not grant.
 * - `anyone_can_remove`: {@link MIN_OTHER_PEOPLE_TO_REMOVE_HALE}. `otherPeople` counts
 *   the numbers code knows, so a member on an email handle is not counted: a low count
 *   leaves the claim out rather than risk saying it in a group too small for it.
 */
export function groupJoinIntroClaims(input: {
  audience: GroupJoinIntroAudience;
  otherPeople: number;
  turnReaderLive: boolean;
  mailNoticeLive: boolean;
}): GroupJoinIntroClaim[] {
  const answersWhenCalled = input.audience === 'shared' || input.turnReaderLive;
  const holds: Record<GroupJoinIntroClaim, boolean> = {
    reads_this_chat: true,
    email_never_shown: !input.mailNoticeLive,
    speaks_when_called: answersWhenCalled,
    private_goes_direct: false,
    anyone_can_remove: input.otherPeople >= MIN_OTHER_PEOPLE_TO_REMOVE_HALE,
  };
  return GROUP_JOIN_INTRO_CLAIMS.filter((claim) => holds[claim]);
}

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
  | { kind: 'stop_ack' }
  | {
      /** VIL-438 (T22): first message to someone a parent added. Facts only. */
      kind: 'member_welcome';
      adderName: string | null;
    }
  | {
      /**
       * VIL-727: what Hale says when it joins a group: who it is, the ground rules that
       * are true today, and (when someone has not been asked yet) who they are.
       */
      kind: 'join_intro';
      audience: GroupJoinIntroAudience;
      /** A household group: the parent Hale is there for. Never set for a shared group. */
      knownParentName: string | null;
      /** A shared group: who added Hale, when known. No household is named as the owner. */
      adderName: string | null;
      claims: readonly GroupJoinIntroClaim[];
      ask: GroupJoinIntroAsk;
    };

export type GroupOnboardingKind = GroupOnboardingRequest['kind'];

export interface GroupOnboardingLine {
  skill: GroupOnboardingSkill;
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

function named(...values: ReadonlyArray<string | null>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function groupOnboardingLineInput(
  request: GroupOnboardingRequest,
  language: ReplyLanguage,
  options: { parentWords?: string | null; noKeyword?: boolean } = {},
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
    case 'role_confirmed':
      return {
        ...base,
        facts: { name: request.name, role: request.role },
        questions: 0,
        mustMention: [...named(request.name)],
      };
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
        mustMention: [
          'Hale',
          ...named(request.name, request.knownParentName),
          ...(options.noKeyword ? [] : ['STOP']),
        ],
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
    case 'member_welcome':
      // VIL-438 (T22) copy facts (Sloane): who added Hale, what Hale can see (only
      // this chat), how to stop (any wording, per person), and that nobody else has to
      // sign up because one family's plan covers the whole group.
      return {
        ...base,
        facts: {
          adderName: request.adderName,
          seesOnlyThisChat: true,
          noSignUpNeeded: true,
          planCoversWholeGroup: true,
          stopIsPerPersonInAnyWording: true,
        },
        questions: 1,
        // No mustMention: a name check would be word matching on parent-facing copy.
        mustMention: [],
        wayOut: true,
      };
    case 'join_intro': {
      // VIL-727. Facts only: whose family a household group is (a shared group names no
      // household), who added Hale to a shared group, the ground rules code checked are
      // true today, and whether to ask who people are. Nothing about any child, plan, or
      // inbox is here, so nothing about them can be said to everyone in the chat.
      const household = request.audience === 'household';
      return {
        ...base,
        skill: GROUP_JOIN_INTRO_SKILL,
        facts: {
          audience: request.audience,
          knownParentName: household ? request.knownParentName : null,
          adderName: household ? null : request.adderName,
          claims: [...request.claims],
          ask: request.ask,
        },
        questions: request.ask === 'none' ? 0 : 1,
        // Hale's own name, as roster_ask carries it, and the parent a household group is for.
        mustMention: ['Hale', ...(household ? named(request.knownParentName) : [])],
      };
    }
  }
}

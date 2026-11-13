import type { ReplyLanguage } from '~/lib/channel/language';
import { type PlanTally, planTallyFacts } from './tally';

export const GROUP_PLAN_RSVP_VOICE_SKILL = 'group-plan-rsvp-voice';
export const GROUP_PLAN_RSVP_READ_SKILL = 'group-plan-rsvp-read';

export type GroupPlanRsvpVoiceKind = 'tracking_started' | 'tally' | 'follow_up';

export interface GroupPlanRsvpVoiceFacts {
  title: string;
  deadline: string | null;
  yesCount: number;
  yesHeads: number;
  yesNames: string[];
  noCount: number;
  noNames: string[];
  maybeCount: number;
  maybeHeads: number;
  maybeNames: string[];
  waitingCount: number;
  waitingNames: string[];
  toGo: number;
}

export interface GroupPlanRsvpLineInput {
  skill: typeof GROUP_PLAN_RSVP_VOICE_SKILL;
  kind: GroupPlanRsvpVoiceKind;
  language: ReplyLanguage;
  facts: GroupPlanRsvpVoiceFacts;
  questions: 0 | 1;
}

export function groupPlanRsvpLineInput(input: {
  kind: GroupPlanRsvpVoiceKind;
  language: ReplyLanguage;
  title: string;
  deadline: string | null;
  tally: PlanTally;
}): GroupPlanRsvpLineInput {
  const questions: 0 | 1 = input.kind === 'tally' ? 0 : 1;
  return {
    skill: GROUP_PLAN_RSVP_VOICE_SKILL,
    kind: input.kind,
    language: input.language,
    facts: {
      title: input.title,
      deadline: input.deadline,
      ...planTallyFacts(input.tally),
    },
    questions,
  };
}

/**
 * VIL-689 · a message could be about more than one open plan, and it spoke to Hale: one
 * group line asking which plan, naming them. Nothing is recorded until someone says.
 */
export interface GroupPlanWhichLineInput {
  skill: typeof GROUP_PLAN_RSVP_VOICE_SKILL;
  kind: 'which_plan';
  language: ReplyLanguage;
  facts: { choices: { title: string; startsAt: string | null }[] };
  questions: 1;
}

export function groupPlanWhichLineInput(input: {
  language: ReplyLanguage;
  choices: readonly { title: string; startsAt: string | null }[];
}): GroupPlanWhichLineInput {
  return {
    skill: GROUP_PLAN_RSVP_VOICE_SKILL,
    kind: 'which_plan',
    language: input.language,
    facts: { choices: input.choices.map((choice) => ({ ...choice })) },
    questions: 1,
  };
}

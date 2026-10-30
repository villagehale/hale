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

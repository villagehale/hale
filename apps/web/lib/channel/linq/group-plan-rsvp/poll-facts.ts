import type { ReplyLanguage } from '~/lib/channel/language';
import type { GroupPollTally } from './poll-tally';

export const GROUP_POLL_VOICE_SKILL = 'group-poll-voice';

/**
 * `poll_started` — Hale just opened the poll a parent asked for.
 * `poll_needs_options` — a parent asked for a poll but gave fewer than two choices.
 * `poll_tally` — someone asked where it stands, or the last person just picked.
 */
export type GroupPollVoiceKind = 'poll_started' | 'poll_needs_options' | 'poll_tally';

export interface GroupPollVoiceFacts {
  question: string | null;
  options: { text: string; votes: number; voterNames: string[] }[];
  leaders: string[];
  votedCount: number;
  waitingCount: number;
  waitingNames: string[];
  toGo: number;
  allIn: boolean;
  /** A native poll card goes out right after this line. */
  card: boolean;
}

export interface GroupPollLineInput {
  skill: typeof GROUP_POLL_VOICE_SKILL;
  kind: GroupPollVoiceKind;
  language: ReplyLanguage;
  facts: GroupPollVoiceFacts;
  questions: 0 | 1;
}

export function groupPollLineInput(input: {
  kind: GroupPollVoiceKind;
  language: ReplyLanguage;
  question: string | null;
  tally: GroupPollTally;
  card: boolean;
}): GroupPollLineInput {
  return {
    skill: GROUP_POLL_VOICE_SKILL,
    kind: input.kind,
    language: input.language,
    facts: {
      question: input.question,
      options: input.tally.options.map((option) => ({
        text: option.text,
        votes: option.votes,
        voterNames: [...option.voterNames],
      })),
      leaders: [...input.tally.leaders],
      votedCount: input.tally.votedCount,
      waitingCount: input.tally.waitingCount,
      waitingNames: [...input.tally.waitingNames],
      toGo: input.tally.toGo,
      allIn: input.tally.toGo === 0 && input.tally.votedCount > 0,
      card: input.card,
    },
    questions: input.kind === 'poll_tally' ? 0 : 1,
  };
}

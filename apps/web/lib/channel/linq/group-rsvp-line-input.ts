import type { ReplyLanguage } from '~/lib/channel/language';
import type { RsvpTally } from './group-rsvp-tally';

/**
 * VIL-102 — facts the voice skill may use. Code owns every count. The model
 * writes the words. Nothing from another family's private slice is handed in.
 */

export const GROUP_RSVP_VOICE_SKILL = 'group-rsvp-voice';

export type GroupRsvpLineKind = 'started' | 'tally' | 'calendar_placed';

export interface GroupRsvpLineFacts {
  title: string | null;
  whenText: string | null;
  location: string | null;
  yes: number;
  no: number;
  pending: number;
  yesNames: string[];
  noNames: string[];
  pendingNames: string[];
  justChanged: string | null;
  calendarAskFor: string | null;
  calendarPlacedFor: string | null;
  inviteSent: boolean;
  send: boolean;
}

export interface GroupRsvpLineInput {
  skill: typeof GROUP_RSVP_VOICE_SKILL;
  kind: GroupRsvpLineKind;
  language: ReplyLanguage;
  parentWords: string | null;
  facts: GroupRsvpLineFacts;
  questions: 0 | 1;
}

export function groupRsvpLineInput(input: {
  kind: GroupRsvpLineKind;
  language: ReplyLanguage;
  parentWords: string | null;
  tally: Pick<RsvpTally, 'yes' | 'no' | 'pending' | 'yesNames' | 'noNames' | 'pendingNames'>;
  title: string | null;
  whenText: string | null;
  location: string | null;
  justChanged: string | null;
  calendarAskFor: string | null;
  calendarPlacedFor: string | null;
  inviteSent: boolean;
  send: boolean;
}): GroupRsvpLineInput {
  const questions: 0 | 1 =
    input.calendarAskFor || (input.kind === 'started' && (!input.title || !input.whenText)) ? 1 : 0;
  return {
    skill: GROUP_RSVP_VOICE_SKILL,
    kind: input.kind,
    language: input.language,
    parentWords: input.parentWords,
    questions,
    facts: {
      title: input.title,
      whenText: input.whenText,
      location: input.location,
      yes: input.tally.yes,
      no: input.tally.no,
      pending: input.tally.pending,
      yesNames: [...input.tally.yesNames],
      noNames: [...input.tally.noNames],
      pendingNames: [...input.tally.pendingNames],
      justChanged: input.justChanged,
      calendarAskFor: input.calendarAskFor,
      calendarPlacedFor: input.calendarPlacedFor,
      inviteSent: input.inviteSent,
      send: input.send,
    },
  };
}

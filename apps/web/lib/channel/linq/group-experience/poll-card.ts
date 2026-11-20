import type { Database } from '@hale/db';
import { linqPollsEnabled } from '../config';
import { sendChoicePoll } from '../poll';
import { primaryParentId } from '../roster-ask';
import {
  GROUP_EXPERIENCE_CHOICE_KIND,
  type GROUP_RSVP_POLL_KIND,
  type GROUP_TIME_POLL_KIND,
} from './kinds';

export type ExperiencePollKind = typeof GROUP_RSVP_POLL_KIND | typeof GROUP_TIME_POLL_KIND;

export interface ExperiencePollCardPort {
  enabled(): boolean;
  send(input: {
    chatId: string;
    familyId: string;
    subjectKey: string;
    pollKind: ExperiencePollKind;
    options: readonly { key: string; text: string; choiceValue: string }[];
    now: Date;
  }): Promise<
    { status: 'sent'; providerMessageId: string } | { status: 'skipped'; reason: string }
  >;
}

export function postgresExperiencePollCard(database: Database): ExperiencePollCardPort {
  return {
    enabled: linqPollsEnabled,
    async send(input) {
      const parentUserId = await primaryParentId(database, input.familyId);
      if (!parentUserId) return { status: 'skipped', reason: 'not_configured' };
      const sent = await sendChoicePoll(database, {
        chatId: input.chatId,
        prompt: null,
        options: input.options.map((option) => ({
          text: option.text,
          pollKind: input.pollKind,
          subjectKey: input.subjectKey,
          choiceKind: GROUP_EXPERIENCE_CHOICE_KIND,
          choiceValue: option.choiceValue,
        })),
        familyId: input.familyId,
        parentUserId,
        now: input.now,
        idempotencyKey: `poll:experience:${input.pollKind}:${input.subjectKey}`,
      });
      if (sent.status === 'sent') {
        return { status: 'sent', providerMessageId: sent.providerMessageId };
      }
      if (sent.status === 'skipped' && sent.reason === 'flag_off') {
        return { status: 'skipped', reason: 'polls_off' };
      }
      return { status: 'skipped', reason: sent.status === 'held' ? sent.reason : 'refused' };
    },
  };
}

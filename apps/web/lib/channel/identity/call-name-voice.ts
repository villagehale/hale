import type { AgentClient } from '@hale/agent';
import {
  type FriendVoiceComposer,
  type FriendVoiceInput,
  createFriendVoiceComposer,
  nameAskVoiceInput,
  speakFriend,
} from '~/lib/channel/intake/friend-voice';
import type { ReplyLanguage } from '~/lib/channel/language';
import { voiceClient } from '~/lib/loop/voice/compose';
import type { ParentCallNameAsk, ParentCallNameVoice } from './parent-call-name';

/**
 * The name ask and its receipt, written by the onboarding model (VIL-417).
 *
 * Code decides the moment and the kind (open ask or confirm of a held Google
 * name) and stores only what passes the shape check. Every sentence here is
 * the model's: a failed compose retries once inside {@link speakFriend}, then
 * sends nothing and pages #ops.
 */

function base(
  step: FriendVoiceInput['step'],
  language: ReplyLanguage,
  parentWords: string,
): FriendVoiceInput {
  return {
    step,
    language,
    address: 'tu',
    introduce: false,
    parentWords,
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
  };
}

/** The ask line for a decided kind, or null when the model could not write one. */
export async function composeParentCallNameAsk(
  composer: FriendVoiceComposer | undefined,
  input: { ask: ParentCallNameAsk; language: ReplyLanguage },
): Promise<string | null> {
  const spoken = await speakFriend(composer, {
    ...base(input.ask.kind === 'confirm' ? 'name_confirm' : 'names', input.language, ''),
    parentName: input.ask.kind === 'confirm' ? input.ask.first : null,
  });
  if (spoken.source === 'unsent' || spoken.body.trim().length === 0) return null;
  return spoken.body;
}

/** Reads a reply to the confirm ask and writes its receipt. */
export function parentCallNameVoice(
  composer: FriendVoiceComposer | undefined,
  language: ReplyLanguage = 'en',
): ParentCallNameVoice {
  return {
    async read(input) {
      const spoken = await speakFriend(composer, {
        ...base('name_reply', language, input.body),
        parentName: input.heldName,
      });
      const reply =
        spoken.source === 'unsent' || spoken.body.trim().length === 0 ? null : spoken.body;
      return {
        reply,
        parentName: spoken.capture.parentName,
        nameConfirmed: spoken.capture.nameConfirmed,
        parentRole: spoken.capture.parentRole,
      };
    },
  };
}

/**
 * The onboarding model reads a reply to the open name ask.
 * `parentName` is empty when the model read a take-back.
 */
export async function readModelParentName(
  composer: FriendVoiceComposer | undefined,
  input: { parentWords: string; language: ReplyLanguage },
): Promise<{ parentName: string | null; nameDeclined: boolean; reply: string | null }> {
  const spoken = await speakFriend(composer, {
    ...nameAskVoiceInput(input.parentWords),
    language: input.language,
  });
  const reply = spoken.source === 'unsent' || spoken.body.trim().length === 0 ? null : spoken.body;
  return {
    parentName: spoken.capture.parentName,
    nameDeclined: spoken.capture.nameDeclined,
    reply,
  };
}

/** The receipt after a typed name was stored, or null when the model could not write one. */
export async function composeNameCapturedReceipt(
  composer: FriendVoiceComposer | undefined,
  input: { name: string; parentWords: string; language: ReplyLanguage },
): Promise<string | null> {
  const spoken = await speakFriend(composer, {
    ...base('name_reply', input.language, input.parentWords),
    parentName: input.name,
  });
  if (spoken.source === 'unsent' || spoken.body.trim().length === 0) return null;
  return spoken.body;
}

export function defaultCallNameComposer(client: AgentClient | null = voiceClient()) {
  return createFriendVoiceComposer(client);
}

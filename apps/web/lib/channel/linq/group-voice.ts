import type { ReplyLanguage } from '~/lib/channel/language';
import {
  type SpokenLineComposer,
  type SpokenLineOptions,
  type SpokenLineResult,
  type SpokenTurn,
  defaultSpokenLineComposer,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import { type GroupLineRequest, groupLineInput } from './group-line-input';

export {
  GROUP_VOICE_SKILL,
  type GroupDecisionFact,
  type GroupKidEventFact,
  type GroupLineKind,
  type GroupLineRequest,
  NO_BOOKING_CLAIM,
  groupLineInput,
} from './group-line-input';

/**
 * VIL-413 / VIL-417. Every line Hale says in the Linq household group, written
 * by the model from real facts. The skill is packages/agent/skills/group-voice.md.
 *
 * This module decides, per kind, what the model must say (mustMention), how
 * many questions it may ask, and which red lines code holds: Hale never says
 * it booked, registered, or reserved anything, because it did not. A line
 * both parents read is vous. A line to one parent uses their stored register,
 * or tu. The calendar card and the Linq name card stay code-built.
 */

export type GroupVoice = SpokenLineComposer;

/** The production composer, or undefined when no model key is set (then nothing is sent and #ops is paged). */
export function defaultGroupVoice(): GroupVoice | undefined {
  return defaultSpokenLineComposer();
}

/**
 * One group line, or nothing. `body` is empty and `fallback` is named when the
 * model could not write it after one retry; the caller leaves its claim unspent.
 */
export async function speakGroupLine(
  voice: GroupVoice | undefined,
  request: GroupLineRequest,
  language: ReplyLanguage,
  options: SpokenLineOptions & {
    parentWords?: string | null;
    recentTurns?: readonly SpokenTurn[];
  } = {},
): Promise<SpokenLineResult> {
  const { parentWords, recentTurns, ...speak } = options;
  return speakLine(voice, groupLineInput(request, language, { parentWords, recentTurns }), speak);
}

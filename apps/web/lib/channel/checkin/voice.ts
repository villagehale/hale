import type { ReplyLanguage } from '~/lib/channel/language';
import {
  type SpokenLineComposer,
  type SpokenLineOptions,
  type SpokenLineResult,
  defaultSpokenLineComposer,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import { type CheckInLineOptions, type CheckInLineRequest, checkInLineInput } from './line-input';

export {
  CHECK_IN_MAX_ACTIVITY_CHARS,
  CHECK_IN_MAX_CHARS,
  CHECK_IN_MAX_NAME_CHARS,
  CHECKIN_VOICE_SKILL,
  type CheckInCadenceFact,
  type CheckInLineKind,
  type CheckInLineOptions,
  type CheckInLineRequest,
  checkInLineInput,
  nameableKids,
} from './line-input';

/**
 * VIL-413 / VIL-417 · every word the evening check-in lane says, written by the model
 * from real facts through the shared spoken-line engine: judged, retried once on a short
 * prompt, and otherwise NOT SENT with #ops paged. There is no sentence underneath.
 */

export type CheckInVoice = SpokenLineComposer;

/** The production composer, or undefined when no model key is set (then nothing is sent and #ops is paged). */
export function defaultCheckInVoice(): CheckInVoice | undefined {
  return defaultSpokenLineComposer();
}

/**
 * One check-in line, or nothing. `body` is empty and `fallback` is named when the model
 * could not write it after one retry; the caller sends nothing and leaves its claim unspent.
 */
export async function speakCheckInLine(
  voice: CheckInVoice | undefined,
  request: CheckInLineRequest,
  language: ReplyLanguage,
  address: 'tu' | 'vous',
  options: SpokenLineOptions & CheckInLineOptions = {},
): Promise<SpokenLineResult> {
  const { parentName, parentWords, ...speak } = options;
  return speakLine(
    voice,
    checkInLineInput(request, language, address, { parentName, parentWords }),
    speak,
  );
}

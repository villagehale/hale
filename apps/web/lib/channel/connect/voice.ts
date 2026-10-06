import type { ReplyLanguage } from '~/lib/channel/language';
import {
  type SpokenLineComposer,
  type SpokenLineOptions,
  defaultSpokenLineComposer,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import { type ConnectLineRequest, connectLineInput, withConnectLinks } from './line-input';

export {
  CONNECT_ACCOUNT_NAME,
  CONNECT_LINK_MINUTES,
  CONNECT_MAX_CHARS,
  CONNECT_VOICE_SKILL,
  type ConnectAccount,
  type ConnectLineKind,
  type ConnectLineRequest,
  GOOGLE_COACHING,
  GOOGLE_PERMISSIONS_URL,
  connectLineInput,
  withConnectLinks,
} from './line-input';

/**
 * VIL-413 / VIL-417 · every word the connect-by-text door says, written by the model from
 * real facts through the shared spoken-line engine: judged, retried once on a short
 * prompt, and otherwise NOT SENT with #ops paged. There is no sentence underneath.
 *
 * The URL is never the model's. It is appended here, on its own line after the prose, so
 * the sentence and the link cannot be split by any later fitting and the token never
 * enters a prompt.
 */

export type ConnectVoice = SpokenLineComposer;

/** The production composer, or undefined when no model key is set (then nothing is sent and #ops is paged). */
export function defaultConnectVoice(): ConnectVoice | undefined {
  return defaultSpokenLineComposer();
}

export interface ConnectLineResult {
  /** The whole text, link lines included, or null when the model could not write it. */
  body: string | null;
  source: 'composed' | 'retry' | 'unsent';
}

/**
 * One connect line with its real link(s) under it, or nothing. `body` is null when the
 * model could not write the prose after one retry; the caller then sends nothing (the
 * minted token simply expires unused) and names the outcome.
 */
export async function speakConnectLine(
  voice: ConnectVoice | undefined,
  request: ConnectLineRequest,
  language: ReplyLanguage,
  options: SpokenLineOptions & { urls?: readonly string[]; parentWords?: string | null } = {},
): Promise<ConnectLineResult> {
  const { urls, parentWords, ...speak } = options;
  const spoken = await speakLine(
    voice,
    connectLineInput(request, language, { parentWords }),
    speak,
  );
  if (spoken.source === 'unsent') return { body: null, source: 'unsent' };
  return { body: withConnectLinks(spoken.body, urls ?? []), source: spoken.source };
}

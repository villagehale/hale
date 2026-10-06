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
  /**
   * The Google heads-up, for a link offer only. Null when this kind has no second
   * bubble, and null together with `body` when either bubble could not be written.
   */
  followUp: string | null;
  source: 'composed' | 'retry' | 'unsent';
}

const LINK_OFFER = new Set<ConnectLineRequest['kind']>(['offer', 'offer_both']);

/**
 * One connect line with its real link(s) under it, or nothing. A link offer is two
 * bubbles, both written before either is sent: the note, then the Google heads-up.
 * `body` is null when either could not be written after one retry; the caller then
 * sends nothing (the minted token simply expires unused) and names the outcome.
 */
export async function speakConnectLine(
  voice: ConnectVoice | undefined,
  request: ConnectLineRequest,
  language: ReplyLanguage,
  options: SpokenLineOptions & {
    urls?: readonly string[];
    parentWords?: string | null;
    address?: 'tu' | 'vous' | null;
  } = {},
): Promise<ConnectLineResult> {
  const { urls, parentWords, address, ...speak } = options;
  const spoken = await speakLine(
    voice,
    connectLineInput(request, language, { parentWords, address }),
    speak,
  );
  if (spoken.source === 'unsent') return { body: null, followUp: null, source: 'unsent' };
  if (!LINK_OFFER.has(request.kind)) {
    return {
      body: withConnectLinks(spoken.body, urls ?? []),
      followUp: null,
      source: spoken.source,
    };
  }
  const heads = await speakLine(
    voice,
    connectLineInput({ kind: 'google_heads_up' }, language, { parentWords, address }),
    speak,
  );
  if (heads.source === 'unsent') return { body: null, followUp: null, source: 'unsent' };
  return {
    body: withConnectLinks(spoken.body, urls ?? []),
    followUp: heads.body,
    source: spoken.source === 'retry' || heads.source === 'retry' ? 'retry' : 'composed',
  };
}

import { checkLinqIMessageCapability, sendLinqVoiceMemo } from '~/lib/channel/outbound-transport';
import { linqVoiceMemosEnabled } from './config';
import type { LinqIMessageCapability } from './transport';

/**
 * VIL-476 · The Design-locked gate for sending a written reply as a native voice memo.
 *
 * Not wired to a product path yet (follow-up: the model's choice + the TTS/host deps).
 * The model writes the reply first, exactly as for a text; this only decides whether
 * that same reply may go as a voice memo, and sends it if so. Every "no" is `text`:
 * the caller sends the written reply as a normal text. A memo that went out is never
 * also sent as text.
 *
 * `text` (never voice) when any holds:
 *   - LINQ_VOICE_MEMOS_ENABLED is not exactly `true`;
 *   - the model did not choose voice for this turn;
 *   - the chat is a group (launch is 1:1 only), or there is no 1:1 chat id;
 *   - the turn is a kind that must stay text (onboarding, connect receipt, poll/card,
 *     short facts to scan) — the caller says so with `textOnly`;
 *   - iMessage capability is not `available` (unknown / unavailable never falls back
 *     to bare audio on RCS/SMS);
 *   - TTS or hosting the audio fails, or the send throws.
 */
export type VoiceReplyDeps = {
  /** Speak the written reply in Hale's one voice; return audio bytes. */
  tts: (text: string) => Promise<Uint8Array>;
  /** Put the bytes at a short-lived public https URL Linq can fetch. */
  host: (audio: Uint8Array) => Promise<string>;
  capability?: (address: string) => Promise<LinqIMessageCapability>;
  send?: typeof sendLinqVoiceMemo;
};

export type VoiceReplyOutcome =
  | { sent: 'voice_memo'; providerMessageId: string | null }
  | { sent: 'text'; why: string };

export async function sendReplyAsVoiceMemo(
  input: {
    text: string;
    modelChoseVoice: boolean;
    isGroup: boolean;
    textOnly: boolean;
    chatId: string | null;
    address: string;
  },
  deps: VoiceReplyDeps,
): Promise<VoiceReplyOutcome> {
  if (!linqVoiceMemosEnabled()) return { sent: 'text', why: 'dark' };
  if (!input.modelChoseVoice) return { sent: 'text', why: 'not_chosen' };
  if (input.isGroup || !input.chatId) return { sent: 'text', why: 'not_one_to_one' };
  if (input.textOnly) return { sent: 'text', why: 'text_only_turn' };
  if (!input.text.trim()) return { sent: 'text', why: 'empty' };
  const capability = await (
    deps.capability ?? ((address) => checkLinqIMessageCapability({ address }))
  )(input.address).catch(() => null);
  if (!capability || capability.status !== 'available') return { sent: 'text', why: 'capability' };
  let url: string;
  try {
    url = await deps.host(await deps.tts(input.text));
  } catch {
    return { sent: 'text', why: 'tts_failed' };
  }
  try {
    const out = await (deps.send ?? sendLinqVoiceMemo)({ chatId: input.chatId, audio: { url } });
    return { sent: 'voice_memo', providerMessageId: out.providerMessageId };
  } catch {
    return { sent: 'text', why: 'send_failed' };
  }
}

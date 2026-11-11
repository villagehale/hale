import type { Database } from '@hale/db';
import {
  checkLinqIMessageCapability,
  sendLinqVoiceMemo,
  uploadLinqAttachment,
} from '~/lib/channel/outbound-transport';
import { hasLinkShape } from '~/lib/format/link-shape';
import { clearForNonAnthropic } from '~/lib/pipeline/provider-clearance';
import { linqVoiceMemosEnabled } from './config';
import type { LinqIMessageCapability } from './transport';
import { VoiceSpeechError, synthesizeHaleVoice } from './voice-speech';

/**
 * VIL-476 / VIL-495 · The Design-locked gate for sending a written reply as a native
 * voice memo.
 *
 * The model writes the reply first, exactly as for a text, and chooses voice for it
 * (the coach's `reply_as_voice_memo` verb). This only decides whether that same reply
 * may go as a voice memo, and sends it if so. Every "no" is `text`: the caller sends the
 * written reply as a normal text. A memo that went out is never also sent as text.
 *
 * `text` (never voice) when any holds:
 *   - LINQ_VOICE_MEMOS_ENABLED is not exactly `true`;
 *   - the model did not choose voice for this turn;
 *   - the chat is a group (launch is 1:1 only), or there is no 1:1 chat id;
 *   - the turn is a kind that must stay text (onboarding, connect receipt, poll/card,
 *     short facts to scan) — the caller says so with `textOnly`;
 *   - the reply carries a link (a spoken URL cannot be tapped);
 *   - iMessage capability is not `available` (unknown / unavailable never falls back
 *     to bare audio on RCS/SMS);
 *   - TTS or hosting the audio fails, or the send throws.
 */
export type VoiceReplyDeps = {
  /** Speak the written reply in Hale's one voice; return audio bytes. */
  tts: (text: string) => Promise<{ audio: Uint8Array; contentType: string }>;
  /** Put the bytes where Linq can send them from. */
  host: (audio: {
    audio: Uint8Array;
    contentType: string;
  }) => Promise<{ url: string } | { attachmentId: string }>;
  capability?: (address: string) => Promise<LinqIMessageCapability>;
  send?: typeof sendLinqVoiceMemo;
};

export type VoiceReplyOutcome =
  | { sent: 'voice_memo'; providerMessageId: string | null }
  | { sent: 'text'; why: string; code?: string };

/**
 * Hale's own send kinds that must stay text. This is the Design lock's never-list
 * (onboard ladder, connect receipt, poll/card, glanceable short facts), keyed by
 * the template Hale stamped on the outbound — not by reading the parent's words.
 */
export function voiceMemoTextOnly(input: {
  templateKey?: string | null;
  hasCard?: boolean;
}): boolean {
  if (input.hasCard) return true;
  const key = input.templateKey;
  if (!key) return false;
  if (key.startsWith('intake:')) return true;
  if (key.startsWith('connector:')) return true;
  if (key === 'linq:poll' || key.startsWith('linq:poll:')) return true;
  if (key === 'linq:experience_card') return true;
  if (key === 'reminder' || key.startsWith('reminder:') || key.startsWith('reminder_')) return true;
  return false;
}

function codeOf(err: unknown): string {
  if (err instanceof VoiceSpeechError) return err.code;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : 'unknown';
}

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
  if (hasLinkShape(input.text)) return { sent: 'text', why: 'has_link' };
  const capability = await (
    deps.capability ?? ((address) => checkLinqIMessageCapability({ address }))
  )(input.address).catch(() => null);
  if (!capability || capability.status !== 'available') return { sent: 'text', why: 'capability' };
  let audio: { url: string } | { attachmentId: string };
  try {
    audio = await deps.host(await deps.tts(input.text));
  } catch (err) {
    return { sent: 'text', why: 'tts_failed', code: codeOf(err) };
  }
  try {
    const out = await (deps.send ?? sendLinqVoiceMemo)({ chatId: input.chatId, audio });
    return { sent: 'voice_memo', providerMessageId: out.providerMessageId };
  } catch (err) {
    return { sent: 'text', why: 'send_failed', code: codeOf(err) };
  }
}

/**
 * The production TTS and hosting for one family's reply. The reply is family state, so
 * a family that has or had a Google connection is refused the Gateway (VIL-556) and its
 * reply goes as text (`tts_failed`, code `not_cleared:<refusal>`). The audio is
 * pre-uploaded to Linq, so Hale hosts nothing public.
 */
export function productionVoiceReplyDeps(database: Database, familyId: string): VoiceReplyDeps {
  return {
    tts: async (text) => {
      const decision = await clearForNonAnthropic(
        { kind: 'family_state', database, familyId },
        'voice_memo_tts',
      );
      if ('refused' in decision) throw new VoiceSpeechError(`not_cleared:${decision.refused}`);
      return synthesizeHaleVoice(text, decision.cleared);
    },
    host: async ({ audio, contentType }) =>
      uploadLinqAttachment({ bytes: audio, contentType, filename: 'hale-voice-memo.mp3' }),
  };
}

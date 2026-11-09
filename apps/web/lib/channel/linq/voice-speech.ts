import {
  type NonGoogleClearance,
  assertClearance,
  clearForNonAnthropic,
} from '~/lib/pipeline/provider-clearance';

/**
 * VIL-495 · Hale's one voice, and the ear for a parent's voice memo, both through the
 * Vercel AI Gateway (OpenAI `tts-1` / `whisper-1`, US).
 *
 * The Gateway is a non-Anthropic transport, so each call spends a
 * {@link NonGoogleClearance} first (VIL-556): Google-derived text never reaches it. A
 * missing key is a named `not_configured`; every other failure is a
 * {@link VoiceSpeechError} with a code, and the caller sends text. No text and no audio
 * is logged here.
 *
 * https://vercel.com/docs/ai-gateway/modalities/text-to-speech
 * https://vercel.com/docs/ai-gateway/modalities/speech-to-text
 */

const GATEWAY_BASE = 'https://ai-gateway.vercel.sh/v4/ai';
export const HALE_TTS_MODEL = 'openai/tts-1';
/** Design lock: one fixed warm-friend voice for every memo Hale sends. */
export const HALE_TTS_VOICE = 'nova';
export const HALE_TRANSCRIBE_MODEL = 'openai/whisper-1';
/** OpenAI's speech input limit. A reply longer than this goes as text. */
const TTS_MAX_CHARS = 4096;
/** Linq's direct-URL limit, and well under Whisper's 25 MB. */
export const VOICE_MEMO_MAX_BYTES = 10_000_000;
const CALL_TIMEOUT_MS = 15_000;
const FETCH_AUDIO_TIMEOUT_MS = 8_000;

export class VoiceSpeechError extends Error {
  constructor(readonly code: string) {
    super(`voice speech: ${code}`);
    this.name = 'VoiceSpeechError';
  }
}

function gatewayKey(): string {
  const key = (process.env.AI_GATEWAY_API_KEY ?? '').trim();
  if (!key) throw new VoiceSpeechError('not_configured');
  return key;
}

async function gatewayCall(
  path: 'speech-model' | 'transcription-model',
  model: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const specHeader =
    path === 'speech-model'
      ? 'ai-speech-model-specification-version'
      : 'ai-transcription-model-specification-version';
  let response: Response;
  try {
    response = await fetchImpl(`${GATEWAY_BASE}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayKey()}`,
        'ai-gateway-protocol-version': '0.0.1',
        [specHeader]: '4',
        'ai-model-id': model,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof VoiceSpeechError) throw err;
    throw new VoiceSpeechError(
      err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
    );
  }
  if (!response.ok) throw new VoiceSpeechError(`http_${response.status}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') throw new VoiceSpeechError('malformed');
  return payload as Record<string, unknown>;
}

/** Speak the written reply in Hale's voice. Returns mp3 bytes. */
export async function synthesizeHaleVoice(
  text: string,
  clearance: NonGoogleClearance,
  fetchImpl: typeof fetch = fetch,
): Promise<{ audio: Uint8Array; contentType: 'audio/mpeg' }> {
  assertClearance(clearance);
  const spoken = text.trim();
  if (!spoken) throw new VoiceSpeechError('empty');
  if (spoken.length > TTS_MAX_CHARS) throw new VoiceSpeechError('too_long');
  const payload = await gatewayCall(
    'speech-model',
    HALE_TTS_MODEL,
    { text: spoken, voice: HALE_TTS_VOICE, outputFormat: 'mp3' },
    fetchImpl,
  );
  if (typeof payload.audio !== 'string' || payload.audio.length === 0) {
    throw new VoiceSpeechError('no_audio');
  }
  const audio = new Uint8Array(Buffer.from(payload.audio, 'base64'));
  if (audio.byteLength === 0) throw new VoiceSpeechError('no_audio');
  if (audio.byteLength > VOICE_MEMO_MAX_BYTES) throw new VoiceSpeechError('too_large');
  return { audio, contentType: 'audio/mpeg' };
}

/**
 * Fetch a parent's voice memo from its https URL and transcribe it. Returns the words,
 * trimmed; an empty transcript is `no_speech`.
 */
export async function transcribeVoiceMemo(
  input: { url: string; mime: string | null },
  clearance: NonGoogleClearance,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  assertClearance(clearance);
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_AUDIO_TIMEOUT_MS),
    });
  } catch {
    throw new VoiceSpeechError('audio_unreachable');
  }
  if (!response.ok) throw new VoiceSpeechError('audio_unreachable');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > VOICE_MEMO_MAX_BYTES) {
    throw new VoiceSpeechError('too_large');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new VoiceSpeechError('audio_empty');
  if (bytes.byteLength > VOICE_MEMO_MAX_BYTES) throw new VoiceSpeechError('too_large');
  const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
  const mediaType = input.mime ?? headerMime ?? 'audio/mp4';
  const payload = await gatewayCall(
    'transcription-model',
    HALE_TRANSCRIBE_MODEL,
    { audio: bytes.toString('base64'), mediaType },
    fetchImpl,
  );
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new VoiceSpeechError('no_speech');
  return text;
}

/**
 * The production ear for the coach (inbound-media.ts `HearVoiceMemo`). A parent's own
 * voice memo is their words, not Google content, so it clears as `parent_text`. Any
 * failure is logged by code and the memo reads as unheard; the turn goes on.
 */
export async function hearVoiceMemo(part: { url: string; mime: string | null }): Promise<
  string | null
> {
  const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'voice_memo_transcribe');
  if ('refused' in decision) return null;
  try {
    return await transcribeVoiceMemo({ url: part.url, mime: part.mime }, decision.cleared);
  } catch (err) {
    console.info(
      { reason: err instanceof VoiceSpeechError ? err.code : 'unknown' },
      'voice memo: not heard',
    );
    return null;
  }
}

/**
 * Voice-input consent + Web Speech API feature-detection — the pure,
 * framework-free core the `useWebVoice` hook builds on, unit-tested without a
 * real recognizer.
 *
 * Privacy gate (hard rule #1): the browser's SpeechRecognition MAY process audio
 * off-device (e.g. Google's servers in Chrome). A parent must opt in ONCE before
 * the mic can start; the choice is persisted locally and defaults to OFF. Audio
 * and transcripts never leave the browser through Hale — the transcript only
 * fills the composer draft the parent reviews before sending.
 */

export const VOICE_CONSENT_STORAGE_KEY = 'hale-voice-consent';

/** The one value we persist to mark an accepted, off-device-processing opt-in. */
const CONSENT_ACCEPTED = 'accepted';

/**
 * Reads the persisted consent, defaulting to OFF for anything missing or
 * unrecognized. Absence of a stored choice is a valid, expected state (the
 * consent has never been shown), so the default here is deliberate, not a masked
 * null.
 */
export function readVoiceConsent(raw: string | null): boolean {
  return raw === CONSENT_ACCEPTED;
}

/** The value to persist once a parent accepts the off-device-processing gate. */
export function serializeVoiceConsent(): string {
  return CONSENT_ACCEPTED;
}

/** The SpeechRecognition constructor (standard or webkit-prefixed), or null. */
export function getSpeechRecognitionCtor(
  win: Pick<Window, 'SpeechRecognition' | 'webkitSpeechRecognition'>,
): SpeechRecognitionConstructor | null {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

/** Whether this browser exposes the Web Speech API at all. */
export function isSpeechRecognitionSupported(
  win: Pick<Window, 'SpeechRecognition' | 'webkitSpeechRecognition'>,
): boolean {
  return getSpeechRecognitionCtor(win) !== null;
}

/**
 * Maps a recognition failure to calm, user-facing copy. Kept verbatim-parity with
 * the mobile hook where the mapping is the same intent: a permission denial reads
 * as a permission ask; anything else is a generic, non-alarming line.
 */
export function voiceErrorMessage(errorCode: string): string {
  if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed') {
    return 'Microphone permission is needed for voice.';
  }
  if (errorCode === 'no-speech') {
    return "Didn't catch that — try again.";
  }
  if (errorCode === 'network') {
    return 'Voice needs a connection right now — check yours and try again.';
  }
  return 'Voice input failed.';
}

/**
 * `not-allowed` from the recognizer maps to a hard, system-level block on the web:
 * once a site's mic permission is denied it stays denied until the parent changes
 * it in browser settings (there is no re-prompt), mirroring the mobile
 * canAskAgain=false case.
 */
export function isPermissionBlockingError(errorCode: string): boolean {
  return errorCode === 'not-allowed' || errorCode === 'service-not-allowed';
}

export const VOICE_UNSUPPORTED_MESSAGE = 'Voice input is not supported in this browser.';
export const VOICE_PERMISSION_BLOCKED_MESSAGE =
  'Microphone access was denied. Enable it in browser settings.';

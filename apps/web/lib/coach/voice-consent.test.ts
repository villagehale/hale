import { describe, expect, it } from 'vitest';
import {
  getSpeechRecognitionCtor,
  isPermissionBlockingError,
  isSpeechRecognitionSupported,
  readVoiceConsent,
  serializeVoiceConsent,
  voiceErrorMessage,
} from './voice-consent';

/**
 * The two seams that gate web voice input, unit-tested without a real recognizer
 * (deterministic, no LLM, no browser):
 *  - the consent gate: a parent must opt IN once before the mic may start;
 *    default OFF, and only the exact accepted marker turns it on;
 *  - feature-detection: an unsupported browser yields no constructor, so the
 *    consumer renders no mic rather than a broken control.
 */

class FakeRecognition {}

/** A window shim exposing only the Speech API fields the detector reads. */
function win(over: {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}): Pick<Window, 'SpeechRecognition' | 'webkitSpeechRecognition'> {
  return over as Pick<Window, 'SpeechRecognition' | 'webkitSpeechRecognition'>;
}

const CTOR = FakeRecognition as unknown as SpeechRecognitionConstructor;

describe('consent gate', () => {
  it('defaults OFF when no choice has been stored', () => {
    expect(readVoiceConsent(null)).toBe(false);
  });

  it('stays OFF for a stored value that is not the accepted marker', () => {
    // A stale / corrupt / "declined" value must never silently enable the mic.
    expect(readVoiceConsent('true')).toBe(false);
    expect(readVoiceConsent('yes')).toBe(false);
    expect(readVoiceConsent('declined')).toBe(false);
    expect(readVoiceConsent('')).toBe(false);
  });

  it('turns ON only after the exact accepted marker is persisted', () => {
    // The round-trip a parent's opt-in takes: serialize on accept, read back true.
    expect(readVoiceConsent(serializeVoiceConsent())).toBe(true);
  });
});

describe('feature-detection fallback', () => {
  it('reports unsupported and yields no constructor when neither API exists', () => {
    const w = win({});
    expect(isSpeechRecognitionSupported(w)).toBe(false);
    expect(getSpeechRecognitionCtor(w)).toBeNull();
  });

  it('detects the standard SpeechRecognition', () => {
    const w = win({ SpeechRecognition: CTOR });
    expect(isSpeechRecognitionSupported(w)).toBe(true);
    expect(getSpeechRecognitionCtor(w)).toBe(CTOR);
  });

  it('falls back to the webkit-prefixed constructor (Chrome/Safari)', () => {
    const w = win({ webkitSpeechRecognition: CTOR });
    expect(isSpeechRecognitionSupported(w)).toBe(true);
    expect(getSpeechRecognitionCtor(w)).toBe(CTOR);
  });
});

describe('error copy + permission classification', () => {
  it('maps a permission denial to the mic-permission line and treats it as a hard block', () => {
    expect(voiceErrorMessage('not-allowed')).toBe('Microphone permission is needed for voice.');
    expect(isPermissionBlockingError('not-allowed')).toBe(true);
    expect(isPermissionBlockingError('service-not-allowed')).toBe(true);
  });

  it('maps non-permission failures to calm copy that is NOT a permission block', () => {
    expect(voiceErrorMessage('no-speech')).toBe("Didn't catch that — try again.");
    expect(voiceErrorMessage('audio-capture')).toBe('Voice input failed.');
    expect(isPermissionBlockingError('no-speech')).toBe(false);
    expect(isPermissionBlockingError('network')).toBe(false);
  });
});

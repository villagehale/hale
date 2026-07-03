'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSpeechRecognitionCtor,
  isPermissionBlockingError,
  isSpeechRecognitionSupported,
  readVoiceConsent,
  serializeVoiceConsent,
  VOICE_CONSENT_STORAGE_KEY,
  VOICE_UNSUPPORTED_MESSAGE,
  voiceErrorMessage,
} from '~/lib/coach/voice-consent';

export interface WebVoiceInput {
  /** Whether this browser exposes the Web Speech API at all. */
  supported: boolean;
  /** True while speech recognition is active. */
  listening: boolean;
  /** null when clean; calm user-facing copy on failure. */
  error: string | null;
  /** True when the mic permission is denied at the browser/system level. */
  permissionBlocked: boolean;
  /**
   * True when the parent has not yet accepted the one-time off-device-processing
   * consent. The consumer shows the consent explainer instead of starting.
   */
  consentNeeded: boolean;
  /** Record the parent's one-time opt-in, then begin listening. */
  acceptConsent: () => void;
  /** Dismiss the consent explainer without opting in (mic stays off). */
  declineConsent: () => void;
  /** Single tap starts (gated by consent); a second tap stops. */
  toggle: () => void;
}

/**
 * Web voice input for the Ask composer — mirrors the mobile `useVoiceInput` state
 * shape (listening / error / permissionBlocked / toggle) on the browser's Web
 * Speech API. Interim results stream into the composer draft via onTranscript on
 * every `result` event, so the field updates live; the parent reviews the draft
 * before sending (no silent capture — audio/transcripts never leave the browser
 * through Hale).
 *
 * Privacy gate (rule #1): the first tap surfaces a one-time consent (consentNeeded)
 * rather than starting; only after acceptConsent() — persisted locally, default
 * OFF — does the recognizer run.
 */
export function useWebVoice(onTranscript: (text: string) => void): WebVoiceInput {
  const [supported, setSupported] = useState(false);
  const [consented, setConsented] = useState(false);
  const [consentNeeded, setConsentNeeded] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported(window));
    setConsented(readVoiceConsent(localStorage.getItem(VOICE_CONSENT_STORAGE_KEY)));
  }, []);

  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor(window);
    if (!Ctor) {
      setError(VOICE_UNSUPPORTED_MESSAGE);
      return;
    }
    setError(null);
    const recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result) text += result[0]?.transcript ?? '';
      }
      if (text) onTranscriptRef.current(text);
    };
    recognition.onerror = (event) => {
      setError(voiceErrorMessage(event.error));
      if (isPermissionBlockingError(event.error)) setPermissionBlocked(true);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, []);

  const acceptConsent = useCallback(() => {
    localStorage.setItem(VOICE_CONSENT_STORAGE_KEY, serializeVoiceConsent());
    setConsented(true);
    setConsentNeeded(false);
    start();
  }, [start]);

  const declineConsent = useCallback(() => setConsentNeeded(false), []);

  const toggle = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (!consented) {
      setConsentNeeded(true);
      return;
    }
    start();
  }, [listening, consented, start]);

  return {
    supported,
    listening,
    error,
    permissionBlocked,
    consentNeeded,
    acceptConsent,
    declineConsent,
    toggle,
  };
}

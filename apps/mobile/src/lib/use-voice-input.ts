import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useRef, useState } from 'react';

type VoiceInput = {
  listening: boolean;
  error: string | null;
  permissionBlocked: boolean;
  toggle: () => Promise<void>;
  reset: () => void;
};

/**
 * Wraps expo-speech-recognition: requests mic+speech permission, starts/stops
 * on-device recognition, and streams the transcript back via onTranscript.
 * Native only — the web preview has no native recognizer, so toggle() no-ops
 * with a message there.
 */
export function useVoiceInput(onTranscript: (text: string) => void): VoiceInput {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  // A late `result` (interim, or a final delivered after we stop) would otherwise
  // re-fill the input after the parent has cleared it on send. This gate drops any
  // transcript that arrives while we aren't actively listening.
  const accepting = useRef(false);

  useSpeechRecognitionEvent('result', (event) => {
    if (!accepting.current) return;
    const transcript = event.results?.[0]?.transcript;
    if (transcript) onTranscript(transcript);
  });
  useSpeechRecognitionEvent('end', () => {
    accepting.current = false;
    setListening(false);
  });
  useSpeechRecognitionEvent('error', (event) => {
    accepting.current = false;
    setError(event.message ?? 'Voice input failed.');
    setListening(false);
  });

  const toggle = async () => {
    setError(null);
    if (listening) {
      accepting.current = false;
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setPermissionBlocked(!perm.canAskAgain);
      setError('Microphone permission is needed for voice.');
      return;
    }
    setPermissionBlocked(false);
    accepting.current = true;
    ExpoSpeechRecognitionModule.start({ lang: 'en-US', interimResults: true });
    setListening(true);
  };

  // On send: stop capture and drop any in-flight transcript so it can't repopulate
  // the input the caller just cleared.
  const reset = () => {
    accepting.current = false;
    if (listening) {
      ExpoSpeechRecognitionModule.abort();
      setListening(false);
    }
  };

  return { listening, error, permissionBlocked, toggle, reset };
}

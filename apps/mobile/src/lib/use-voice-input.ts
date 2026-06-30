import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useState } from 'react';

type VoiceInput = {
  listening: boolean;
  error: string | null;
  toggle: () => Promise<void>;
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

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results?.[0]?.transcript;
    if (transcript) onTranscript(transcript);
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', (event) => {
    setError(event.message ?? 'Voice input failed.');
    setListening(false);
  });

  const toggle = async () => {
    setError(null);
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone permission is needed for voice.');
      return;
    }
    ExpoSpeechRecognitionModule.start({ lang: 'en-US', interimResults: true });
    setListening(true);
  };

  return { listening, error, toggle };
}

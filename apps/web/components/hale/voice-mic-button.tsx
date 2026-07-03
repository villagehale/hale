'use client';

import { Mic } from 'lucide-react';
import { useId } from 'react';
import { Button } from '~/components/ui/button';
import { VOICE_PERMISSION_BLOCKED_MESSAGE } from '~/lib/coach/voice-consent';
import { useWebVoice } from './use-web-voice';

/**
 * The voice-input control for the Ask composer: a trailing mic button that fills
 * to spruce while listening, a one-time privacy consent (rule #1), and a calm
 * aria-live status line. Interim transcript streams into the composer draft via
 * onTranscript; the parent reviews the draft before sending.
 *
 * Feature-detected: when the browser has no Web Speech API the control does not
 * render at all — never a broken mic.
 */
export function VoiceMicButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const voice = useWebVoice(onTranscript);
  const consentId = useId();
  const statusId = useId();

  if (!voice.supported) return null;

  const problem = voice.permissionBlocked
    ? VOICE_PERMISSION_BLOCKED_MESSAGE
    : voice.error;
  // The visible alert announces problems; the sr-only live region carries only the
  // transient listening state, so a screen reader isn't told the error twice.
  const listeningStatus = voice.listening ? 'Listening…' : null;

  return (
    <div className="relative">
      {problem ? (
        <p className="voice-note meta italic text-apricot-deep" role="alert">
          {problem}
        </p>
      ) : null}

      {voice.consentNeeded ? (
        <section aria-labelledby={consentId} className="voice-consent">
          <p id={consentId} className="font-medium text-spruce">
            Use voice input?
          </p>
          <p className="meta mt-1">
            Voice uses your browser&rsquo;s speech recognition, which may process audio off your
            device (for example, Google&rsquo;s servers in Chrome) and needs microphone permission.
            Hale never sends your audio anywhere — the words only fill the box for you to review
            before sending.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" onClick={voice.acceptConsent}>
              Turn on voice
            </Button>
            <Button variant="ghost" onClick={voice.declineConsent}>
              Not now
            </Button>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        onClick={voice.toggle}
        aria-pressed={voice.listening}
        aria-label={voice.listening ? 'stop listening' : 'start voice input'}
        aria-describedby={listeningStatus ? statusId : undefined}
        className={`composer-mic cursor-pointer${voice.listening ? ' composer-mic-live' : ''}`}
      >
        <Mic aria-hidden size={18} />
      </button>

      <output id={statusId} aria-live="polite" className="sr-only">
        {listeningStatus}
      </output>
    </div>
  );
}

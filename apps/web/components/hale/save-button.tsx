'use client';

import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

type State = 'idle' | 'pending' | 'error';

interface SaveButtonProps {
  /** POST /api/village/:id/save — a TOGGLE; the response carries the resulting
   * `saved` boolean, which drives the button's pressed state. */
  endpoint: string;
  /** Whether THIS family has already privately saved this candidate (server-resolved),
   * so a saved card survives the streamed feed remounting the button. */
  initiallySaved?: boolean;
}

/**
 * The private-save ("I'm interested") bookmark toggle — the web parity for the
 * mobile RecCard/detail-sheet save. A save is PRIVATE and low-commitment: it neither
 * enrolls the child nor sends anything for approval (that is Accept), and it is never
 * surfaced to anyone but the saving family (unlike the Endorse count). So the copy
 * stays "I'm interested" / "saved", never "sent for your approval".
 *
 * Honest UX (mirrors EndorseButton): the toggle honours the server's returned `saved`
 * state, surfaces the error rather than a silent success, and reflects the state on
 * `aria-pressed` for assistive tech.
 */
export function SaveButton({ endpoint, initiallySaved = false }: SaveButtonProps) {
  const [saved, setSaved] = useState(initiallySaved);
  const [state, setState] = useState<State>('idle');
  const capture = useAnalytics();

  async function toggle() {
    setState('pending');
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.status !== 200) {
        setState('error');
        return;
      }
      const { saved: nowSaved } = (await res.json()) as { saved: boolean };
      capture('village_save', { saved: nowSaved });
      setSaved(nowSaved);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  const label =
    state === 'pending'
      ? 'saving…'
      : state === 'error'
        ? 'try again'
        : saved
          ? 'saved'
          : "i'm interested";

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        icon={saved ? BookmarkCheck : Bookmark}
        onClick={toggle}
        disabled={state === 'pending'}
        aria-live="polite"
        aria-pressed={saved}
      >
        {label}
      </Button>
      {state === 'error' ? (
        <p className="field-error" role="alert">
          couldn’t save that just now — try again.
        </p>
      ) : null}
    </div>
  );
}

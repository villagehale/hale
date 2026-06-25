'use client';

import { Check, Share2 } from 'lucide-react';
import { useState } from 'react';
import type { ButtonVariant } from '~/components/ui/button';
import { Button } from '~/components/ui/button';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

type State = 'idle' | 'pending' | 'shared' | 'copied' | 'ready' | 'error';

/** Maps a non-200 mint response to its reason — what happened + what to do. */
export function shareErrorMessage(status: number): string {
  if (status === 404) return 'nothing to share here yet.';
  if (status === 401) return 'sign in to share.';
  if (status === 403 || status === 501) return 'sharing isn’t available yet.';
  return 'couldn’t make a link just now — try again in a moment.';
}

interface ShareButtonProps {
  /** The POST endpoint that mints (idempotently) the public token and returns
   * `{ link }`. Each mint writes an audit row server-side (rule #6). */
  endpoint: string;
  /** Idle button label — action + object (DESIGN copy rule). */
  label: string;
  /** What is being shared — used in the native share-sheet title/text. */
  shareTitle?: string;
  variant?: ButtonVariant;
}

/**
 * The one-tap share affordance, reused on every village + public surface
 * (week-plan, picks, a single pick). Mobile-first: it prefers the native share
 * sheet (`navigator.share`) so the parent can fire it straight into iMessage /
 * WhatsApp; on a desktop browser it copies the link; on a clipboard-blocked
 * browser it surfaces the link to copy by hand. Honest about failure — each
 * non-200 maps to its own reason, never a blanket "try again".
 *
 * The link itself is the public, privacy-safe token page; this component never
 * sees a child name, DOB, or precise location — only the minted URL (rule #1).
 */
export function ShareButton({
  endpoint,
  label,
  shareTitle = 'on Hale',
  variant = 'secondary',
}: ShareButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capture = useAnalytics();

  async function share() {
    setState('pending');
    setError(null);
    let res: Response;
    try {
      res = await fetch(endpoint, { method: 'POST' });
    } catch {
      setError(shareErrorMessage(0));
      setState('error');
      return;
    }
    if (res.status !== 200) {
      setError(shareErrorMessage(res.status));
      setState('error');
      return;
    }
    const { link: url } = (await res.json()) as { link: string };
    setLink(url);
    capture('share');

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: shareTitle, url });
        setState('shared');
        return;
      } catch {
        // User dismissed the sheet, or share failed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('ready');
    }
  }

  const buttonLabel =
    state === 'pending'
      ? 'making a link…'
      : state === 'copied'
        ? 'link copied'
        : state === 'shared'
          ? 'shared'
          : state === 'error'
            ? 'try again'
            : label;

  const done = state === 'copied' || state === 'shared';

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        icon={done ? Check : Share2}
        onClick={share}
        disabled={state === 'pending'}
        aria-live="polite"
      >
        {buttonLabel}
      </Button>
      {state === 'error' && error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {state === 'ready' && link ? (
        <label className="field-group">
          <span className="field-label">copy your link</span>
          <input
            className="field"
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      ) : null}
    </div>
  );
}

'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'copied' | 'ready' | 'error';

/** Error copy keyed by why the share failed — what happened + what to do. */
export function errorMessage(status: number): string {
  if (status === 404) return 'no week plan yet to share.';
  if (status === 401) return 'sign in to share your week.';
  if (status === 403 || status === 501) return 'sharing isn’t available yet.';
  return 'couldn’t share just now — try again in a moment.';
}

/**
 * Mints (or re-fetches) the public share link via POST /api/village/share and
 * copies it to the clipboard. Honest about failure (never a silent success):
 * each non-200 maps to its own reason — 404 (no plan), 401 (sign in),
 * 403/501 (unavailable), 5xx/network (retryable) — never a blanket "try again".
 * On a clipboard-blocked browser it still surfaces the link to copy by hand. The
 * link itself is the public, privacy-safe `/w/:token` page.
 *
 * With `nothingToShare`, renders a disabled affordance so a parent with
 * candidates but no week plan still sees why there's nothing to share.
 */
export function ShareWeekButton({ nothingToShare = false }: { nothingToShare?: boolean }) {
  const [state, setState] = useState<State>('idle');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (nothingToShare) {
    return (
      <button type="button" className="btn-secondary" disabled>
        nothing to share this week yet
      </button>
    );
  }

  async function share() {
    setState('pending');
    setError(null);
    let res: Response;
    try {
      res = await fetch('/api/village/share', { method: 'POST' });
    } catch {
      setError(errorMessage(0));
      setState('error');
      return;
    }
    if (res.status !== 200) {
      setError(errorMessage(res.status));
      setState('error');
      return;
    }
    const { link: url } = (await res.json()) as { link: string };
    setLink(url);
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('ready');
    }
  }

  const label =
    state === 'pending'
      ? 'making a link…'
      : state === 'copied'
        ? 'link copied'
        : state === 'error'
          ? 'try again'
          : 'share this week';

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn-secondary"
        onClick={share}
        disabled={state === 'pending'}
        aria-live="polite"
      >
        {label}
      </button>
      {state === 'error' && error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {state === 'ready' && link ? (
        <label className="field-group">
          <span className="field-label">copy your link</span>
          <input className="field" value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
        </label>
      ) : null}
    </div>
  );
}

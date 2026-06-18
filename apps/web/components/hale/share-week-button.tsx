'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'copied' | 'ready' | 'error';

/**
 * Mints (or re-fetches) the public share link via POST /api/village/share and
 * copies it to the clipboard. Honest about failure (never a silent success): on
 * a clipboard-blocked browser it still surfaces the link to copy by hand. The
 * link itself is the public, privacy-safe `/w/:token` page.
 */
export function ShareWeekButton() {
  const [state, setState] = useState<State>('idle');
  const [link, setLink] = useState<string | null>(null);

  async function share() {
    setState('pending');
    const res = await fetch('/api/village/share', { method: 'POST' });
    if (res.status !== 200) {
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
          ? 'could not share — try again'
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
      {state === 'ready' && link ? (
        <p className="meta text-slate-green break-all">copy your link: {link}</p>
      ) : null}
    </div>
  );
}

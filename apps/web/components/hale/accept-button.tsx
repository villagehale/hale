'use client';

import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

type State = 'idle' | 'pending' | 'added' | 'error';

const LABEL: Record<State, string> = {
  idle: 'add to my week',
  pending: 'adding…',
  added: 'added to your week',
  error: 'could not add — try again',
};

/**
 * Posts a village candidate's accept to /api/village/:id/accept (built in the
 * next phase). Optimistic but honest: pending while in flight, "added to your
 * week" on 202, the error surfaced (never a silent success). The worker drafts
 * the routine action; this only hands off.
 */
export function AcceptButton({ href }: { href: string }) {
  const [state, setState] = useState<State>('idle');
  const capture = useAnalytics();

  async function accept() {
    setState('pending');
    try {
      const res = await fetch(href, { method: 'POST' });
      const added = res.status === 202;
      if (added) capture('add_to_week');
      setState(added ? 'added' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-primary"
      onClick={accept}
      disabled={state === 'pending' || state === 'added'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

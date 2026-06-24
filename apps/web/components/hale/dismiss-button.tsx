'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'dismissed' | 'error';

const LABEL: Record<State, string> = {
  idle: 'dismiss draft',
  pending: 'dismissing…',
  dismissed: 'dismissed',
  error: 'could not dismiss — try again',
};

/**
 * Posts a drafted action's dismissal to /api/actions/:id/decline — the "no" of the
 * consent queue (rule #4: a parent must be able to refuse a draft, not only
 * approve it). The route transitions the draft out of approval and writes its
 * audit_log row (rule #6); this never executes the action. Honest states: pending
 * in flight, "dismissed" on 200, the error surfaced — never a silent success.
 */
export function DismissButton({ actionId }: { actionId: string }) {
  const [state, setState] = useState<State>('idle');

  async function dismiss() {
    setState('pending');
    try {
      const res = await fetch(`/api/actions/${actionId}/decline`, { method: 'POST' });
      setState(res.status === 200 ? 'dismissed' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={dismiss}
      disabled={state === 'pending' || state === 'dismissed'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

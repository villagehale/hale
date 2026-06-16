'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'sent' | 'error';

const LABEL: Record<State, string> = {
  idle: 'approve and send',
  pending: 'sending…',
  sent: 'sent for you',
  error: 'could not send — try again',
};

/**
 * Posts the parent's approval to /api/actions/:id/approve. Optimistic but
 * honest: pending while in flight, "sent for you" on 202, the error surfaced
 * (never a silent success). The worker does the real send; this only hands off.
 */
export function ApproveButton({ actionId }: { actionId: string }) {
  const [state, setState] = useState<State>('idle');

  async function approve() {
    setState('pending');
    try {
      const res = await fetch(`/api/actions/${actionId}/approve`, { method: 'POST' });
      setState(res.status === 202 ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-primary"
      onClick={approve}
      disabled={state === 'pending' || state === 'sent'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'approved' | 'error';

const LABEL: Record<State, string> = {
  idle: 'approve & send',
  pending: 'approving…',
  approved: 'approved',
  error: 'could not approve — try again',
};

/**
 * Posts a drafted action's approval to /api/actions/:id/approve. This is the
 * consent surface for rule #4: only a signed-in parent's click moves a draft from
 * "Hale wrote it" to "execute it" (the route enqueues actions.approved; the worker
 * does the actual send). Honest states: pending in flight, "approved" on 202, the
 * error surfaced — never a silent success.
 */
export function ApproveButton({ actionId }: { actionId: string }) {
  const [state, setState] = useState<State>('idle');

  async function approve() {
    setState('pending');
    try {
      const res = await fetch(`/api/actions/${actionId}/approve`, { method: 'POST' });
      setState(res.status === 202 ? 'approved' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-primary"
      onClick={approve}
      disabled={state === 'pending' || state === 'approved'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

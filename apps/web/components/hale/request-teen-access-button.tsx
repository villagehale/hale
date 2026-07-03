'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'requested' | 'error';

const LABEL: Record<State, string> = {
  idle: 'request access',
  pending: 'requesting…',
  requested: 'requested — your teen was asked',
  error: 'could not request — try again',
};

/**
 * Posts a request for time-limited access to a 13+ teen's redacted approval
 * content to /api/teen-content-grant (rule #1 named exception). This reveals
 * NOTHING on click — it records an explicit, audited, time-limited grant REQUEST
 * and notifies the teen, so a redacted row is decidable (pending the grant) rather
 * than a decision on invisible content. Honest states: pending in flight,
 * "requested" on 202, the error surfaced — never a silent success.
 */
export function RequestTeenAccessButton({ actionId }: { actionId: string }) {
  const [state, setState] = useState<State>('idle');

  async function request() {
    setState('pending');
    try {
      const res = await fetch('/api/teen-content-grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId }),
      });
      setState(res.status === 202 ? 'requested' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={request}
      disabled={state === 'pending' || state === 'requested'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

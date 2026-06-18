'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type State = 'idle' | 'pending' | 'joined' | 'error';

const LABEL: Record<State, string> = {
  idle: 'join this family',
  pending: 'joining…',
  joined: 'joined — opening your home…',
  error: 'could not join — try again',
};

/**
 * Posts the invitee's acceptance to /api/invite/:token/accept and, on success,
 * routes to the family's home. Optimistic but honest: pending while in flight, the
 * error surfaced (never a silent success).
 */
export function InviteAcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>('idle');

  async function accept() {
    setState('pending');
    try {
      const res = await fetch(`/api/invite/${token}/accept`, { method: 'POST' });
      if (res.status === 200) {
        setState('joined');
        router.push('/home');
        return;
      }
      setState('error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-primary"
      onClick={accept}
      disabled={state === 'pending' || state === 'joined'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

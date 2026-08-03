'use client';

import { useId, useState } from 'react';

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
export function ApproveButton({
  actionId,
  labelledBy,
}: {
  actionId: string;
  labelledBy?: string;
}) {
  const [state, setState] = useState<State>('idle');
  const selfId = useId();

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
      id={selfId}
      className="btn-primary"
      onClick={approve}
      disabled={state === 'pending' || state === 'approved'}
      aria-live="polite"
      // In a list every row's button reads "approve & send" alike, so the row's
      // preview has to join the accessible name. It joins by REFERENCE — this
      // button's own text plus the id of the row's preview node — never as an
      // `aria-label` copy of the preview: rrweb records attribute values verbatim
      // past the text mask, so that copy would put the draft (child name and all)
      // into a session replay (VIL-274, rule #1).
      aria-labelledby={labelledBy ? `${selfId} ${labelledBy}` : undefined}
    >
      {LABEL[state]}
    </button>
  );
}

'use client';

import { useState } from 'react';

type State = 'idle' | 'confirming' | 'pending' | 'scheduled' | 'error';

/**
 * Requests deletion of the whole account/family (PIPEDA/Law 25 right-to-erasure).
 * Confirm-gated: the first click reveals the real scope ("this removes everything
 * Hale holds about your family") and only the explicit confirm posts
 * {confirm:true} to /api/rights/delete. The request SCHEDULES deletion after a
 * grace period — it does not erase immediately — so the success copy states the
 * effective date, and the parent can still change their mind during the window.
 * Honest states: pending in flight, the scheduled date on 202, the error surfaced.
 */
export function DeleteAccountButton() {
  const [state, setState] = useState<State>('idle');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);

  async function confirmDelete() {
    setState('pending');
    try {
      const res = await fetch('/api/rights/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (res.status !== 202) {
        setState('error');
        return;
      }
      const body = (await res.json()) as { scheduledDeletionAt?: string };
      setScheduledFor(body.scheduledDeletionAt ?? null);
      setState('scheduled');
    } catch {
      setState('error');
    }
  }

  if (state === 'scheduled') {
    const when = scheduledFor
      ? new Date(scheduledFor).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : null;
    return (
      <p className="meta text-slate-green" aria-live="polite">
        {when
          ? `deletion scheduled for ${when}. contact us before then to cancel.`
          : 'deletion scheduled. contact us before it completes to cancel.'}
      </p>
    );
  }

  if (state === 'confirming' || state === 'pending' || state === 'error') {
    return (
      <div className="flex flex-col gap-y-3" aria-live="polite">
        <p className="text-spruce leading-relaxed max-w-md">
          This removes <strong>everything</strong> Hale holds about your family — your children,
          your history, and every connected service. Deletion begins after a grace period, so you
          can still change your mind. This can&rsquo;t be undone once it completes.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={confirmDelete}
            disabled={state === 'pending'}
          >
            {state === 'pending' ? 'scheduling…' : 'yes, delete my account'}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setState('idle')}
            disabled={state === 'pending'}
          >
            keep my account
          </button>
        </div>
        {state === 'error' ? (
          <p className="meta text-berry">could not schedule deletion — try again.</p>
        ) : null}
      </div>
    );
  }

  return (
    <button type="button" className="link text-berry" onClick={() => setState('confirming')}>
      delete my account
    </button>
  );
}

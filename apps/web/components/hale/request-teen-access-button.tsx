'use client';

import { useState } from 'react';

type State = 'idle' | 'asking' | 'pending' | 'requested' | 'error';

/**
 * Requests time-limited access to a 13+ teen's redacted approval content (rule #1
 * named exception). Clicking reveals NOTHING: it opens a reason field, and
 * submitting records an explicit, audited, scope-bound grant REQUEST and notifies
 * the teen. Nothing unlocks until the teen assents (rule #5).
 *
 * The reason is required by the route, so it is required here too — and the copy
 * says plainly who will read it, because the teen is shown these words. Honest
 * states throughout: pending in flight, the outcome on 202, errors surfaced —
 * never a silent success, and never a claim that access was already granted.
 */
export function RequestTeenAccessButton({ actionId }: { actionId: string }) {
  const [state, setState] = useState<State>('idle');
  const [reason, setReason] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState('pending');
    try {
      const res = await fetch('/api/teen-content-grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, reason }),
      });
      setState(res.status === 202 ? 'requested' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'requested') {
    return (
      <p className="meta text-slate-green" aria-live="polite">
        requested — your teen was asked. nothing opens until they agree.
      </p>
    );
  }

  if (state === 'idle') {
    return (
      <button type="button" className="btn-secondary" onClick={() => setState('asking')}>
        request access
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-2">
      <label htmlFor={`teen-reason-${actionId}`} className="meta text-slate-green">
        why do you need to see this? your teen is shown what you write.
      </label>
      <textarea
        id={`teen-reason-${actionId}`}
        className="input min-h-[4.5rem]"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        required
        disabled={state === 'pending'}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {state === 'error' ? (
          <p className="meta text-slate-green" aria-live="polite">
            could not request — try again
          </p>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setState('idle')}
          disabled={state === 'pending'}
        >
          cancel
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={state === 'pending' || reason.trim().length < 3}
        >
          {state === 'pending' ? 'requesting…' : 'ask my teen'}
        </button>
      </div>
    </form>
  );
}

'use client';

import { useState } from 'react';

type State = 'idle' | 'confirming' | 'pending' | 'dismissed' | 'error';

const LABEL: Record<Exclude<State, 'confirming'>, string> = {
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
 *
 * Declining is destructive (it permanently moves the draft out of approval and
 * writes an audit row) with no undo, so it is confirm-gated with a lightweight
 * inline two-step — matching the remove-child / delete-account affordances — rather
 * than firing on a single click.
 */
export function DismissButton({ actionId, label }: { actionId: string; label?: string }) {
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

  if (state === 'confirming') {
    return (
      <span className="flex flex-wrap items-center gap-3">
        <span className="meta">
          dismiss{label ? ' this draft' : ''}
          {label ? <span data-hale-pii> — {label}</span> : null}?
        </span>
        <button
          type="button"
          className="link meta text-apricot-deep"
          onClick={dismiss}
        >
          yes, dismiss
        </button>
        <button type="button" className="link meta" onClick={() => setState('idle')}>
          keep
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => setState('confirming')}
      disabled={state === 'pending' || state === 'dismissed'}
      aria-live="polite"
      // In a list every row's button reads "dismiss draft" alike; the draft
      // preview disambiguates which draft each button acts on for a screen reader.
      aria-label={label ? `${LABEL.idle}: ${label}` : undefined}
    >
      {LABEL[state]}
    </button>
  );
}

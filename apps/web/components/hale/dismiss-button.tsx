'use client';

import { useId, useState } from 'react';

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
 *
 * `label` is the draft preview, rendered ONLY as a text node inside the confirm
 * step's `[data-hale-pii]` span. The accessible name takes the same preview by
 * REFERENCE instead (`labelledBy` — the id of the row's preview node), because a
 * replay records attribute values verbatim past the text mask (VIL-274, rule #1).
 */
export function DismissButton({
  actionId,
  label,
  labelledBy,
}: {
  actionId: string;
  label?: string;
  labelledBy?: string;
}) {
  const [state, setState] = useState<State>('idle');
  const selfId = useId();

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
      id={selfId}
      className="btn-secondary"
      onClick={() => setState('confirming')}
      disabled={state === 'pending' || state === 'dismissed'}
      aria-live="polite"
      // In a list every row's button reads "dismiss draft" alike; the row's preview
      // node joins the accessible name by reference (see the component note).
      aria-labelledby={labelledBy ? `${selfId} ${labelledBy}` : undefined}
    >
      {LABEL[state]}
    </button>
  );
}

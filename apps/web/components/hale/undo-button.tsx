'use client';

import { useId, useState } from 'react';

type State = 'idle' | 'pending' | 'undone' | 'error';

const LABEL: Record<State, string> = {
  idle: 'undo this',
  pending: 'undoing…',
  undone: 'undone',
  error: 'could not undo — it may be outside the 24h window',
};

/**
 * Takes back a calendar placement Hale made, via /api/actions/:id/undo — the same
 * primitive the SMS "undo" command runs, so a tap and a text reverse identically.
 * The row only offers this when the server would accept it (HistoryView.undoable,
 * derived from the shared window gate), and the error copy names the real reason a
 * late attempt fails rather than a generic retry.
 *
 * Not confirm-gated, unlike dismiss: undo is itself the reversal, it soft-deletes a
 * placement the parent can have re-made, and putting a confirm in front of the
 * take-back makes the take-back feel like the risky move.
 */
export function UndoButton({ actionId, labelledBy }: { actionId: string; labelledBy?: string }) {
  const [state, setState] = useState<State>('idle');
  const selfId = useId();

  async function undo() {
    setState('pending');
    try {
      const res = await fetch(`/api/actions/${actionId}/undo`, { method: 'POST' });
      setState(res.status === 200 ? 'undone' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      id={selfId}
      className="btn-secondary"
      onClick={undo}
      disabled={state === 'pending' || state === 'undone'}
      aria-live="polite"
      // Every row's button reads alike in a list, so the row's preview joins the
      // accessible name by REFERENCE (this button's text + the preview node's id)
      // rather than as an `aria-label` copy — a replay records attributes verbatim
      // past the text mask (VIL-274, rule #1).
      aria-labelledby={labelledBy ? `${selfId} ${labelledBy}` : undefined}
    >
      {LABEL[state]}
    </button>
  );
}

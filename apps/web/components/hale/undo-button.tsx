'use client';

import { useState } from 'react';

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
export function UndoButton({ actionId, label }: { actionId: string; label?: string }) {
  const [state, setState] = useState<State>('idle');

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
      className="btn-secondary"
      onClick={undo}
      disabled={state === 'pending' || state === 'undone'}
      aria-live="polite"
      // Every row's button reads alike in a list; the row's preview disambiguates
      // which placement this one takes back for a screen reader.
      aria-label={label ? `${LABEL.idle}: ${label}` : undefined}
    >
      {LABEL[state]}
    </button>
  );
}

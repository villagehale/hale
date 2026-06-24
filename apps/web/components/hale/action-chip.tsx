'use client';

import { useState } from 'react';
import type { ActionIntent } from '~/components/hale/use-ask-hale';

type State = 'idle' | 'pending' | 'drafted' | 'error';

/**
 * A gated action chip — the inline-action thesis. Tapping it routes the intent
 * through the EXISTING approval engine, which creates a DRAFT a parent must approve
 * on the Approvals surface (rule #4: Hale never auto-acts). The copy is honest: the
 * success state says the action was drafted for approval, never "done".
 */
export function ActionChip({
  intent,
  focusedChildId,
  sourceAnswer,
}: {
  intent: ActionIntent;
  focusedChildId: string | null;
  sourceAnswer: string;
}) {
  const [state, setState] = useState<State>('idle');

  async function draft() {
    if (state === 'pending' || state === 'drafted') return;
    setState('pending');
    try {
      const res = await fetch('/api/coach/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentKind: intent.kind,
          ...(focusedChildId ? { focusedChildId } : {}),
          sourceAnswer,
        }),
      });
      setState(res.ok ? 'drafted' : 'error');
    } catch {
      setState('error');
    }
  }

  const label =
    state === 'drafted'
      ? 'added to your approvals'
      : state === 'pending'
        ? 'drafting…'
        : state === 'error'
          ? 'couldn’t draft — try again'
          : intent.label;

  return (
    <button
      type="button"
      className="pill pill-apricot pill-action cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={draft}
      disabled={state === 'pending' || state === 'drafted'}
      aria-live="polite"
    >
      {label}
    </button>
  );
}

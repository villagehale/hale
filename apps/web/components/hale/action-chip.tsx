'use client';

import { useState } from 'react';
import type { ActionIntent } from '~/components/hale/use-ask-hale';

type State = 'idle' | 'pending' | 'drafted' | 'error';

interface ActionRequest {
  url: '/api/coach/action';
  body: { intentKind: string; sourceAnswer: string; focusedChildId?: string };
}

/**
 * Build the draft request for an inline action. `focusedChildId` is the scope the
 * chip drafts UNDER — the child the SOURCE TURN was asked about, not the live scope
 * chip (which the parent may have moved since). A null scope omits the field (a
 * whole-family draft). Pure + exported so the child attribution is unit-tested
 * without a DOM (mirrors book-button's buildBookRequest).
 */
export function buildActionRequest(
  intentKind: string,
  focusedChildId: string | null,
  sourceAnswer: string,
): ActionRequest {
  return {
    url: '/api/coach/action',
    body: {
      intentKind,
      ...(focusedChildId ? { focusedChildId } : {}),
      sourceAnswer,
    },
  };
}

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
      const req = buildActionRequest(intent.kind, focusedChildId, sourceAnswer);
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
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

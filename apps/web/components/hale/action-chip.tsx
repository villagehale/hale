'use client';

import { useState } from 'react';
import { ActionApprovalCard } from '~/components/hale/action-approval-card';
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
 * Reads the drafted action's id off a successful /api/coach/action response. The
 * route returns 202 `{ status: 'drafted_for_approval', actionId }`; anything else
 * (or a 202 missing the id) yields null so the chip surfaces an error instead of
 * rendering an approval card wired to nothing. Exported so the parse is unit-tested
 * without a DOM (mirrors buildActionRequest).
 */
export async function parseDraftResponse(res: Response): Promise<string | null> {
  if (!res.ok) return null;
  const body = (await res.json()) as { actionId?: unknown };
  return typeof body.actionId === 'string' ? body.actionId : null;
}

/**
 * A gated action chip — the inline-action thesis. Tapping it routes the intent
 * through the EXISTING approval engine, which creates a DRAFT a parent must approve
 * (rule #4: Hale never auto-acts). On a successful draft the chip hands off to an
 * inline ActionApprovalCard so the parent approves or rejects right here in the chat,
 * rather than being sent off to the Approvals surface. The copy is honest: nothing
 * says "done".
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
  const [actionId, setActionId] = useState<string | null>(null);

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
      const id = await parseDraftResponse(res);
      if (id) {
        setActionId(id);
        setState('drafted');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  if (state === 'drafted' && actionId) {
    return (
      <ActionApprovalCard actionId={actionId} label={intent.label} actionType={intent.actionType} />
    );
  }

  const label =
    state === 'pending'
      ? 'drafting…'
      : state === 'error'
        ? 'couldn’t draft — try again'
        : intent.label;

  return (
    <button
      type="button"
      className="pill pill-apricot pill-action cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={draft}
      disabled={state === 'pending'}
      aria-live="polite"
    >
      {label}
    </button>
  );
}

'use client';

import { useState } from 'react';

/** The Ask-Hale intent kind for booking a health item — mapped server-side to the
 * create_calendar_event action type (action-intent.ts). Named so the request
 * builder and its test can't drift from the engine's trust boundary. */
export const BOOK_CHECKUP_INTENT = 'book_checkup';

type State = 'idle' | 'pending' | 'drafted' | 'error';

const LABEL: Record<State, string> = {
  idle: 'we’ll help you book →',
  pending: 'drafting…',
  drafted: 'added to your approvals',
  error: 'couldn’t draft — try again',
};

export interface BookRequest {
  url: string;
  body: { intentKind: string; sourceAnswer: string; focusedChildId?: string };
}

/**
 * Builds the request that routes a "help me book" tap through the EXISTING approval
 * engine (POST /api/coach/action → draftInlineAction). Pure + exported so the
 * book_checkup wiring is unit-tested without a DOM. A child-scoped item carries
 * focusedChildId; a family-wide item omits it (the route drops an unknown child to
 * null anyway — rule #1).
 */
export function buildBookRequest(what: string, childId: string | undefined): BookRequest {
  return {
    url: '/api/coach/action',
    body: {
      intentKind: BOOK_CHECKUP_INTENT,
      sourceAnswer: `Help me book: ${what}`,
      ...(childId ? { focusedChildId: childId } : {}),
    },
  };
}

/**
 * Turns a health item into a REAL gated action: it drafts a calendar event held
 * for the parent's approval (rule #4) via the approval engine — never an inline
 * execution, never a fake "booked". The label stays honest ("we'll help you
 * book") and, on success, tells the parent it's waiting in their approvals. It
 * stays disabled after a draft so the same item isn't queued twice.
 */
export function BookButton({ what, childId }: { what: string; childId?: string }) {
  const [state, setState] = useState<State>('idle');

  async function request() {
    if (state === 'pending' || state === 'drafted') return;
    setState('pending');
    try {
      const { url, body } = buildBookRequest(what, childId);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setState(res.ok ? 'drafted' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="link cursor-pointer text-left"
      onClick={request}
      disabled={state === 'pending' || state === 'drafted'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

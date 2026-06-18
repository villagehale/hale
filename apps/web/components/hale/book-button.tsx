'use client';

import { useState } from 'react';
import { logBookingRequested } from '~/lib/companion/log';
import type { BookingResult } from '~/lib/companion/log-types';

type State = 'idle' | 'pending' | 'requested' | 'preview' | 'error';

const LABEL: Record<State, string> = {
  idle: 'we’ll help you book →',
  pending: 'noting that…',
  requested: 'noted — we’ll help you book',
  preview: 'preview only — not saved',
  error: 'could not note — try again',
};

/**
 * Records a parent's intent to book a health item via the logBookingRequested
 * server action. Honest: Hale can't actually book an external appointment, so
 * the label says "we'll help you book" and a success only confirms the intent
 * was noted — never a fake "booked". On a 'requested' it stays disabled so the
 * intent isn't double-logged.
 */
export function BookButton({ what, childId }: { what: string; childId?: string }) {
  const [state, setState] = useState<State>('idle');

  async function request() {
    setState('pending');
    const result: BookingResult = await logBookingRequested({ what, childId });
    switch (result.status) {
      case 'requested':
        setState('requested');
        break;
      case 'preview':
        setState('preview');
        break;
      default:
        setState('error');
    }
  }

  return (
    <button
      type="button"
      className="link cursor-pointer text-left"
      onClick={request}
      disabled={state === 'pending' || state === 'requested'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}

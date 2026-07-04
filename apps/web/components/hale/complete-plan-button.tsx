'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { completePlan } from '~/lib/plan/plan-actions';

/**
 * The soft "done" affordance on a parent-authored plan. Calls completePlan
 * (family-scoped + audited 'plan_completed' + revalidates /plan). A completed plan
 * renders a static sage pill; an open plan is a button that flips to that pill on a
 * successful stamp. Disabled while in flight so a double-click can't fire twice.
 * Mirrors DoneButton's sage-pill treatment so a settled plan reads the same as a
 * settled companion item.
 */
type State = 'idle' | 'pending' | 'done' | 'error';

const LABEL: Record<Exclude<State, 'done'>, string> = {
  idle: 'mark done',
  pending: 'saving…',
  error: 'couldn’t save — try again',
};

function DonePill() {
  return (
    <span className="pill pill-sage">
      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
      done
    </span>
  );
}

export function CompletePlanButton({
  planId,
  alreadyDone,
}: {
  planId: string;
  alreadyDone: boolean;
}) {
  const [state, setState] = useState<State>(alreadyDone ? 'done' : 'idle');

  if (state === 'done') return <DonePill />;

  async function onComplete() {
    if (state === 'pending') return;
    setState('pending');
    const result = await completePlan(planId);
    setState(result.status === 'completed' ? 'done' : 'error');
  }

  return (
    <button
      type="button"
      className="pill pill-action pill-sage"
      onClick={onComplete}
      disabled={state === 'pending'}
      aria-live="polite"
    >
      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
      {LABEL[state]}
    </button>
  );
}

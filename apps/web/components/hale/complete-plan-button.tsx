'use client';

import { Check } from 'lucide-react';
import { useId, useState } from 'react';
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
  labelledBy,
}: {
  planId: string;
  alreadyDone: boolean;
  /** The id of the card's plan-title node — see the aria-labelledby note below. */
  labelledBy?: string;
}) {
  const [state, setState] = useState<State>(alreadyDone ? 'done' : 'idle');
  const selfId = useId();

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
      id={selfId}
      className="pill pill-action pill-sage"
      onClick={onComplete}
      disabled={state === 'pending'}
      aria-live="polite"
      // Per-row plans all carry an identical "mark done" control, so the plan's
      // title has to join the accessible name. It joins by REFERENCE — this
      // button's own text plus the id of the card's title node — never as an
      // `aria-label` copy: rrweb records attribute values verbatim past the text
      // mask, so that copy would put the plan into a session replay (VIL-276).
      aria-labelledby={labelledBy ? `${selfId} ${labelledBy}` : undefined}
    >
      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
      {LABEL[state]}
    </button>
  );
}

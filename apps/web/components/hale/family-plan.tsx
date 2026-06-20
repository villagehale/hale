'use client';

import { useState } from 'react';
import type { PlanTier } from '@hale/types';
import { setPlanAction } from '~/lib/family/children-actions';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'error' };

const PLAN_OPTIONS: { tier: PlanTier; label: string; note: string }[] = [
  { tier: 'free', label: 'free', note: 'observe + draft · no autonomous action' },
  { tier: 'plus', label: 'plus', note: 'hale acts on your approval · $24/mo' },
  { tier: 'family', label: 'family', note: 'autonomy + commerce + portals · $49/mo' },
];

/**
 * Shows and changes the family's plan tier. No charge is taken here — the choice is
 * captured on the family; billing is a later concern. A change writes immediately
 * and audits family_plan_updated (rule #6).
 */
export function FamilyPlan({ planTier }: { planTier: PlanTier }) {
  const [selected, setSelected] = useState<PlanTier>(planTier);
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function choose(tier: PlanTier) {
    if (tier === selected) {
      return;
    }
    const previous = selected;
    setSelected(tier);
    setState({ kind: 'saving' });
    const result = await setPlanAction(tier);
    if (result.status === 'updated') {
      setState({ kind: 'saved' });
      return;
    }
    setSelected(previous);
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
  }

  return (
    <div className="space-y-4 max-w-lg">
      <fieldset className="space-y-3">
        <legend className="sr-only">choose a plan</legend>
        {PLAN_OPTIONS.map((opt) => {
          const isSelected = selected === opt.tier;
          return (
            <label
              key={opt.tier}
              className={`cursor-pointer text-left p-4 rounded-[var(--r-md)] transition-colors flex items-baseline justify-between ${
                isSelected
                  ? 'bg-oat border border-spruce'
                  : 'border border-rule-strong hover:border-spruce'
              }`}
            >
              <span>
                <span className="font-display text-xl block">{opt.label}</span>
                <span className="meta block mt-1">{opt.note}</span>
              </span>
              <input
                type="radio"
                name="family-plan"
                value={opt.tier}
                checked={isSelected}
                onChange={() => choose(opt.tier)}
                disabled={state.kind === 'saving'}
                className="sr-only"
              />
              {isSelected ? <span className="eyebrow text-spruce">current</span> : null}
            </label>
          );
        })}
      </fieldset>
      {state.kind === 'saved' ? (
        <output className="meta text-slate-green block">saved — nothing charged today.</output>
      ) : null}
      {state.kind === 'preview' ? (
        <output className="meta text-slate-green block">
          sign-in isn&rsquo;t configured in this preview, so nothing was saved.
        </output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="meta text-apricot-deep" role="alert">
          couldn&rsquo;t change your plan just now — please try again.
        </p>
      ) : null}
    </div>
  );
}

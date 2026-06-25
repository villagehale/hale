'use client';

import { useState } from 'react';
import type { BillingPeriod, PlanTier } from '@hale/types';
import { setPlanAction } from '~/lib/family/children-actions';
import { type FamilyPlanState, FamilyPlanView } from './family-plan-view';

/**
 * The plan & billing section. Owns the billing-period + plan state and the server
 * action; FamilyPlanView does the rendering. The village (Free) is the active
 * default and fully functional; the paid tiers are surfaced with a soft "notify
 * me" CTA because billing isn't wired (no checkout, no charge). Switching back to
 * Free writes immediately and audits family_plan_updated (rule #6) — choosing Free
 * never charges anything.
 */
export function FamilyPlan({ planTier }: { planTier: PlanTier }) {
  const [current, setCurrent] = useState<PlanTier>(planTier);
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [state, setState] = useState<FamilyPlanState>({ kind: 'idle' });

  async function selectFree() {
    if (current === 'free') {
      return;
    }
    const previous = current;
    setCurrent('free');
    setState({ kind: 'saving' });
    const result = await setPlanAction('free');
    if (result.status === 'updated') {
      setState({ kind: 'saved' });
      return;
    }
    setCurrent(previous);
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
  }

  return (
    <FamilyPlanView
      current={current}
      period={period}
      state={state}
      onPeriodChange={setPeriod}
      onSelectFree={selectFree}
      onNotify={(tier) => setState({ kind: 'notified', tier })}
    />
  );
}

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * "notify me when it's ready" must record real interest, not just flip local UI
 * state — otherwise the "we'll let you know" copy is a lie (a state-honesty P0).
 * The stateful FamilyPlan wrapper captures plan_notify_requested with the tier via
 * the existing analytics hook when onNotify fires.
 *
 * The wrapper pulls in the setPlanAction server action (next-auth → next/server),
 * so it's stubbed for this markup-only test; FamilyPlanView is stubbed to invoke
 * onNotify on render so the wiring under test runs without a DOM click.
 */

const capture = vi.fn();

vi.mock('~/lib/analytics/posthog-provider', () => ({
  useAnalytics: () => capture,
}));

vi.mock('~/lib/family/children-actions', () => ({
  setPlanAction: vi.fn(),
}));

vi.mock('./family-plan-view', () => ({
  FamilyPlanView: ({ onNotify }: { onNotify: (tier: string) => void }) => {
    onNotify('plus');
    return null;
  },
}));

describe('FamilyPlan — notify me persists interest', () => {
  it('captures plan_notify_requested with the tier when onNotify fires', async () => {
    capture.mockClear();
    const { FamilyPlan } = await import('./family-plan');

    renderToStaticMarkup(createElement(FamilyPlan, { planTier: 'free' }));

    expect(capture).toHaveBeenCalledWith('plan_notify_requested', { tier: 'plus' });
  });
});

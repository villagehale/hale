import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Upgrade CTA must actually start a Stripe Checkout session — POST the chosen
 * tier + period to /api/billing/checkout — not just flip local UI state. The
 * stateful FamilyPlan wrapper owns that fetch; FamilyPlanView is stubbed to invoke
 * onUpgrade on render so the wiring under test runs without a DOM click. fetch is
 * stubbed to fail so no navigation happens; we assert the request it made.
 */

const capture = vi.fn();

vi.mock('~/lib/analytics/posthog-provider', () => ({
  useAnalytics: () => capture,
}));

vi.mock('~/lib/family/children-actions', () => ({
  setPlanAction: vi.fn(),
}));

vi.mock('./family-plan-view', () => ({
  FamilyPlanView: ({ onUpgrade }: { onUpgrade: (tier: string) => void }) => {
    onUpgrade('plus');
    return null;
  },
}));

describe('FamilyPlan — Upgrade starts a checkout session', () => {
  it('POSTs the tier + period to the checkout route and records the intent', async () => {
    capture.mockClear();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { FamilyPlan } = await import('./family-plan');
    renderToStaticMarkup(createElement(FamilyPlan, { planTier: 'free', billingConfigured: true }));
    // let the async upgrade() microtask settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/checkout',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      tier: 'plus',
      period: 'monthly',
    });
    expect(capture).toHaveBeenCalledWith('plan_upgrade_started', { tier: 'plus', period: 'monthly' });

    vi.unstubAllGlobals();
  });
});

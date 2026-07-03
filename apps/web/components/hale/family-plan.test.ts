import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAN_DISPLAY } from '@hale/types';
import { FamilyPlanView } from './family-plan-view';

/**
 * The settings plan section renders all three tiers from the shared display source
 * with a monthly↔annual toggle. The current tier reads "your plan"; the paid tiers
 * carry a soft "notify me" CTA (billing isn't wired — no checkout). The view is
 * tested directly (the stateful wrapper owns the server action) — same split as
 * account-menu-view.
 */
function render(
  overrides: Partial<Parameters<typeof FamilyPlanView>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(FamilyPlanView, {
      current: 'free',
      period: 'monthly',
      state: { kind: 'idle' },
      onPeriodChange: () => {},
      onSelectFree: () => {},
      onNotify: () => {},
      ...overrides,
    }),
  );
}

describe('FamilyPlanView (settings plan section)', () => {
  it('renders all three tiers with their display names', () => {
    const html = render();
    expect(html).toContain(PLAN_DISPLAY.free.name);
    expect(html).toContain(PLAN_DISPLAY.plus.name);
    expect(html).toContain(PLAN_DISPLAY.family.name);
  });

  it('shows the confirmed monthly prices in the monthly period', () => {
    const html = render({ period: 'monthly' });
    expect(html).toContain('Free');
    expect(html).toContain('$9 CAD/mo');
    expect(html).toContain('$19 CAD/mo');
  });

  it('shows the confirmed annual prices in the annual period', () => {
    const html = render({ period: 'annual' });
    expect(html).toContain('$79 CAD/yr');
    expect(html).toContain('$159 CAD/yr');
  });

  it('offers a monthly and an annual billing period', () => {
    const html = render();
    expect(html).toContain('monthly');
    expect(html).toContain('annual');
  });

  it('marks the current tier and softens the paid CTA (no checkout)', () => {
    const html = render({ current: 'free' });
    expect(html).toContain('your plan');
    expect(html).toContain('notify me');
  });
});

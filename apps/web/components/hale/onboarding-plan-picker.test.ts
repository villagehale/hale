import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAN_DISPLAY } from '@hale/types';
import { OnboardingPlanPicker } from './onboarding-plan-picker';

/**
 * The onboarding plan step renders all three tiers from the shared display source,
 * free-leads and free-selected by default, with the monthly prices shown (the
 * toggle defaults to monthly). Rendered to static markup — same approach as the
 * account-menu / village-feed tests.
 */
function render(selected: Parameters<typeof OnboardingPlanPicker>[0]['selected'] = 'free'): string {
  return renderToStaticMarkup(
    createElement(OnboardingPlanPicker, { selected, onSelect: () => {} }),
  );
}

describe('OnboardingPlanPicker', () => {
  it('renders all three tiers with their display names', () => {
    const html = render();
    expect(html).toContain(PLAN_DISPLAY.free.name);
    expect(html).toContain(PLAN_DISPLAY.plus.name);
    expect(html).toContain(PLAN_DISPLAY.family.name);
  });

  it('shows the confirmed monthly prices (toggle defaults to monthly)', () => {
    const html = render();
    expect(html).toContain('Free');
    expect(html).toContain('$9/mo');
    expect(html).toContain('$19/mo');
  });

  it('offers a monthly and an annual billing period', () => {
    const html = render();
    expect(html).toContain('monthly');
    expect(html).toContain('annual');
  });

  it('marks the free tier as the selected default', () => {
    const html = render('free');
    expect(html).toContain('selected');
    expect(html).toContain('checked');
    expect(html).toContain('value="free"');
  });
});

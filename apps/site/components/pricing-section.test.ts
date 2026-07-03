import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAN_DISPLAY } from '@hale/types';
import { PricingSection } from './pricing-section.js';

/**
 * The landing pricing section renders the three tiers from the shared display
 * source, free-leads, with both monthly and annual prices shown and a free-to-start
 * framing. Rendered to static markup — the section is a pure server component.
 */
const html = renderToStaticMarkup(createElement(PricingSection));

describe('PricingSection (landing pricing)', () => {
  it('renders all three tiers with their display names', () => {
    expect(html).toContain(PLAN_DISPLAY.free.name);
    expect(html).toContain(PLAN_DISPLAY.plus.name);
    expect(html).toContain(PLAN_DISPLAY.family.name);
  });

  it('shows both monthly and annual prices for the paid tiers', () => {
    expect(html).toContain('$9 CAD/mo');
    expect(html).toContain('$79 CAD/yr');
    expect(html).toContain('$19 CAD/mo');
    expect(html).toContain('$159 CAD/yr');
  });

  it('leads with the village being free', () => {
    expect(html).toContain('Free');
    expect(html).toContain('The village is free');
    expect(html).toContain('Join free');
  });

  it('keeps paid CTAs soft — no checkout, paid tiers marked coming soon', () => {
    expect(html).toContain('Coming soon');
    expect(html).toContain('Founding families');
    expect(html.toLowerCase()).not.toContain('checkout');
  });
});

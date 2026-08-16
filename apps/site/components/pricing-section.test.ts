import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import { PricingSection } from './pricing-section.js';

/**
 * The landing pricing section renders the three tiers from the shared display
 * source, free-leads, with both monthly and annual prices shown and a free-to-start
 * framing. Rendered to static markup — the section is a pure server component.
 */
const html = renderToStaticMarkup(createElement(PricingSection));

/** Escape a string for use inside a RegExp — hrefs carry `+`, `?` and `.`. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  });

  it('routes every tier to a LIVE action — no dead waitlist, checkout, or "Coming soon"', () => {
    expect(html).not.toContain('Coming soon');
    expect(html).not.toContain('#waitlist');
    expect(html.toLowerCase()).not.toContain('checkout');
    // Free and paid alike open the one front door the site chrome offers. There is one
    // CTA per tier, and all three carry the same destination — free vs paid differs in
    // emphasis (btn-primary vs btn-secondary), not in where it goes.
    const { href, label } = chromeCta();
    expect([...html.matchAll(new RegExp(escapeRe(href.replace(/&/g, '&amp;')), 'g'))]).toHaveLength(
      PLAN_TIERS_ORDERED.length,
    );
    expect([...html.matchAll(new RegExp(escapeRe(label), 'g'))]).toHaveLength(
      PLAN_TIERS_ORDERED.length,
    );
  });

  /**
   * The regression this replaced a label-pin with. Every tier CTA used to hardcode the
   * app's /onboarding wizard, which no longer exists — so the pricing page's only
   * action 308'd the reader back to the marketing homepage. Asserted under the LIVE
   * config, because that is what a reader actually gets.
   */
  it('sends a reader to the texting door under the live config — never the deleted wizard', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const live = renderToStaticMarkup(createElement(PricingSection));
    expect(chromeCta().href).toMatch(/^sms:/);
    expect(live).toContain('sms:+16475551234');
    expect(live).not.toContain('/onboarding');
  });

  it('carries the founding-families banner with the first-100 badge promise', () => {
    expect(html).toContain('Founding families join free.');
    expect(html).toContain('first 100 families get a permanent founding badge');
  });
});

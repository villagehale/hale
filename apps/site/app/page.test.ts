import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import LandingPage from './page.js';

/**
 * The warm-white homepage redesign (July 2026): a calm hero, the Ask Hale and
 * Village feature sections, a real-answer FAQ, and a navy CTA band. Every claim
 * is honest — approval-first, Canadian residency, 0–18 scope — and "Get started"
 * always points at the app sign-up funnel. Testimonials stay gated off (no real
 * quotes yet). Rendered to static markup to assert the wiring.
 */
const html = renderToStaticMarkup(createElement(LandingPage));

describe('LandingPage (hero)', () => {
  it('leads with the "done alone" headline and the honest, approval-first subtext', () => {
    expect(html).toContain('Parenting was never meant to be done');
    // "alone." is set in the serif italic accent span.
    expect(html).toContain('alone.');
    expect(html).toContain(
      'Hale quietly prepares the helpful things — reminders, logs, plans, local ideas — and never acts without your say-so.',
    );
  });

  it('carries the beta badge and the trust marquee chips (no fabricated logos)', () => {
    expect(html).toContain('Free while in beta');
    expect(html).toContain('Approval-first');
    expect(html).toContain('PIPEDA-compliant');
    expect(html).toContain('Data stays in Canada');
    expect(html).toContain('Built for families, not feeds');
  });
});

describe('LandingPage (feature sections)', () => {
  it('names both feature headlines', () => {
    expect(html).toContain('One quiet helper for the whole household.');
    expect(html).toContain('Your neighbourhood, working for you.');
  });

  it('marks the sample village activity card as illustrative', () => {
    expect(html).toContain('Illustrative');
  });
});

describe('LandingPage (FAQ — real, verified answers)', () => {
  it('renders the five real questions', () => {
    expect(html).toContain('Is my family’s data safe with Hale?');
    expect(html).toContain('Will Hale ever act without me?');
    expect(html).toContain('What ages does Hale support?');
    expect(html).toContain('What does Hale cost?');
    expect(html).toContain('Can both parents use it?');
  });

  it('answers honestly: observe-only, 0–18 scope, free in beta, co-parent', () => {
    expect(html).toContain('observe-only mode');
    expect(html).toContain('newborn through the teen years');
    expect(html).toContain('free while it’s in beta');
    expect(html).toContain('invite a co-parent');
  });
});

describe('LandingPage (funnel — Get started → app sign-up)', () => {
  it('points every "Get started" CTA at the app sign-up', () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"[^>]*>\s*Get started/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toBe(`${APP_URL}/sign-up`);
    }
  });

  it('has a navy CTA band and a contact link', () => {
    expect(html).toContain('Ready to feel');
    expect(html).toContain('on top of it all?');
    expect(html).toContain('href="/contact"');
  });
});

describe('LandingPage (footer + honesty)', () => {
  it('carries the plain Hale copyright and real legal links', () => {
    expect(html).toContain('© 2026 Hale. All rights reserved.');
    expect(html).toContain(`href="${APP_URL}/privacy"`);
    expect(html).toContain(`href="${APP_URL}/terms"`);
  });

  it('never renders placeholder testimonials in the default (gated-off) build', () => {
    expect(html.toLowerCase()).not.toContain('placeholder testimonial');
    expect(html).not.toContain('• Testimonials');
  });
});

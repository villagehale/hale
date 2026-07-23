import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { FAQ } from '~/lib/faq/index.js';
import LandingPage from './page.js';

/**
 * The warm-white homepage redesign (July 2026): a calm hero, the Concierge and
 * Village feature sections, and a navy CTA band. Every claim
 * is honest — approval-first, Canadian residency, 0–18 scope — and "Get started"
 * always starts the public onboarding wizard (aha-first: steps 1–6 run pre-auth;
 * the account ask is step 6). Testimonials stay gated off (no real quotes yet).
 * Rendered to static markup to assert the wiring.
 */
const html = renderToStaticMarkup(createElement(LandingPage));

describe('LandingPage (hero)', () => {
  // The headline and subtext reveal word-by-word — each word is its own span —
  // so assert against the tag-stripped visible text, not a contiguous HTML slice.
  const heroText = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  it('leads with the "done alone" headline and a village-thesis subtext that threads local activities', () => {
    expect(heroText).toContain('Parenting was never meant to be done alone.');
    expect(heroText).toContain(
      'Hale brings back the village — the trusted local classes and groups near you — and quietly prepares the rest: reminders, logs, and plans you approve before anything happens.',
    );
  });

  it('carries the honest hero badge and the quiet static trust line (no rolling marquee)', () => {
    expect(html).toContain('Built in Canada — private by default');
    expect(html).toContain('Approval-first');
    expect(html).toContain('PIPEDA-compliant');
    expect(html).toContain('Data stays in Canada');
    expect(html).toContain('Newborn to eighteen');
    expect(html).toContain('Private by default');
    // the removed rolling-marquee tagline must not return
    expect(html).not.toContain('Built for families, not feeds');
  });

  it('sets the Hale wordmark in the serif face in both nav and footer', () => {
    const serifWordmarks = [...html.matchAll(/font-serif[^"]*"[^>]*>\s*Hale\s*</g)];
    expect(serifWordmarks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('LandingPage (feature sections)', () => {
  it('names both feature headlines and uses the product’s Concierge language', () => {
    expect(html).toContain('Hale Concierge');
    expect(html).toContain('Ask Concierge to log a nap');
    expect(html).toContain('One quiet helper for the whole household.');
    expect(html).toContain('Your neighbourhood, working for you.');
  });

  it('marks the sample village activity card as illustrative', () => {
    expect(html).toContain('Illustrative');
  });
});

describe('LandingPage (single canonical product FAQ)', () => {
  it('links to /faq instead of duplicating product answers in a homepage accordion', () => {
    expect(html).toContain('href="/faq"');
    expect(html).not.toContain('id="faq"');
    for (const item of FAQ) {
      expect(html).not.toContain(item.question);
    }
  });

  it('labels the editorial library as Parenting guides rather than a second Answers destination', () => {
    expect(html).toContain('Parenting guides');
    expect(html).not.toContain('Parenting answers');
  });
});

describe('LandingPage (funnel — Get started → onboarding wizard)', () => {
  it('points every "Get started" CTA at the public onboarding wizard', () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"[^>]*>\s*Get started/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toBe(`${APP_URL}/onboarding`);
    }
  });

  it('wires the restored hero geo CTAs: Join free → onboarding, preview → /preview', () => {
    expect(html).toContain('Join free — Toronto and the GTA');
    expect(html).toContain('See what Hale finds for you');
    const joinHref = html.match(/href="([^"]*)"[^>]*>\s*Join free/)?.[1];
    expect(joinHref).toBe(`${APP_URL}/onboarding`);
    const previewHref = html.match(/href="([^"]*)"[^>]*>\s*See what Hale finds for you/)?.[1];
    expect(previewHref).toBe(`${APP_URL}/preview`);
  });

  it('restores the geo eyebrow, village narrative, and pronunciation', () => {
    expect(html).toContain('Toronto and the GTA');
    expect(html).toContain('Hale turns the trusted, word-of-mouth village parents used to have');
    expect(html).toContain('/HAH-leh/');
    expect(html).toContain('Hawaiian for home.');
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

describe('LandingPage (palette + honesty)', () => {
  it('mentions no "beta" anywhere on the homepage', () => {
    expect(html.toLowerCase()).not.toContain('beta');
  });

  it('keeps page-level chrome to the three-family palette (no green/blue accents)', () => {
    // The removed off-palette accents (green #1F8A4C/#E7F6EC, blue #3B5BDB/#EDF0FA)
    // must not appear anywhere in the rendered homepage chrome.
    for (const hex of ['#1F8A4C', '#E7F6EC', '#3B5BDB', '#EDF0FA']) {
      expect(html).not.toContain(hex);
    }
  });
});

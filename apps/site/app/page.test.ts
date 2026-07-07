import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import LandingPage from './page.js';

/**
 * The landing spec after the activity-first repositioning (July 2026): the hero
 * sells activity discovery + Hale doing the booking, the join CTA is free and
 * GTA-scoped, paid tiers capture a waitlist instead of "Coming soon", and the
 * product name is "Hale" — "Village Hale" appears only as the legal entity.
 * Rendered to static markup to assert the wiring.
 */
const html = renderToStaticMarkup(createElement(LandingPage));

describe('LandingPage (activity-first hero)', () => {
  it('leads with the activities headline and the plan-the-week promise', () => {
    // The accent span splits "Find the | best activities" in the markup.
    expect(html).toContain('Find the');
    expect(html).toContain('best activities');
    expect(html).toContain('for your child near you.');
    expect(html).toContain('Let Hale plan the week around them.');
  });

  it('carries the toddler-to-tryouts subhead with booking explicit', () => {
    expect(html).toContain('From toddler playgroups to hockey tryouts');
    expect(html).toContain('handles the booking and reminders');
  });

  it('points the primary join CTA at sign-up, free and GTA-scoped', () => {
    expect(html).toContain('Join free — Toronto and GTA');
    const joinHrefs = [...html.matchAll(/href="([^"]*)"[^>]*>\s*Join free — Toronto and GTA/g)].map(
      (m) => m[1],
    );
    expect(joinHrefs.length).toBeGreaterThan(0);
    for (const href of joinHrefs) {
      expect(href).toBe(`${APP_URL}/sign-up`);
    }
  });

  it('keeps the pre-auth value preview CTA', () => {
    expect(html).toContain(`href="${APP_URL}/preview"`);
    expect(html).toContain('See what Hale finds for you');
  });

  it('points every "Join the village" CTA at the app sign-up (not sign-in)', () => {
    const joinHrefs = [...html.matchAll(/href="([^"]*)"[^>]*>\s*Join the village/g)].map(
      (m) => m[1],
    );
    for (const href of joinHrefs) {
      expect(href).toBe(`${APP_URL}/sign-up`);
    }
  });
});

describe('LandingPage (how it works — booking explicit)', () => {
  it('names all four steps, with Hale doing the actual booking in step 3', () => {
    expect(html).toContain('Tell Hale your child’s age and what they love');
    expect(html).toContain('See what families near you actually recommend this week');
    expect(html).toContain('Hale drafts your week’s plan — and handles the booking');
    expect(html).toContain('Share what worked. Your village gets smarter.');
  });
});

describe('LandingPage (trust ladder with concrete examples)', () => {
  it('grounds each ladder step in a real-parent example', () => {
    expect(html).toContain('library story-time most Saturdays');
    expect(html).toContain('drafts the registration for Tuesday music class');
    expect(html).toContain('books the swim class when a spot opens');
  });
});

describe('LandingPage (social proof + waitlist)', () => {
  it('drops the clinical "illustrative examples" disclaimer, keeps the privacy line', () => {
    expect(html.toLowerCase()).not.toContain('illustrative examples');
    expect(html).toContain('no family is ever named');
  });

  it('wires the paid tiers to the waitlist instead of "Coming soon"', () => {
    expect(html).not.toContain('Coming soon');
    expect(html).toContain('Join the waitlist');
    expect(html).toContain('href="#waitlist"');
    expect(html).toContain('id="waitlist"');
  });

  it('carries the founding-families banner with the first-100 badge promise', () => {
    expect(html).toContain('Founding families join free');
    expect(html).toContain('first 100');
  });
});

describe('LandingPage (naming: Hale product, Village Hale legal-only)', () => {
  it('uses "Village Hale" only for the legal entity', () => {
    const withoutLegal = html.replaceAll('Village Hale Technologies Inc.', '');
    expect(withoutLegal).not.toContain('Village Hale');
  });
});

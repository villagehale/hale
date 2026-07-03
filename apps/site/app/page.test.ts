import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import LandingPage from './page.js';

/**
 * At public launch the landing CTAs lead into the app's account-creation funnel
 * (sign-up → onboarding), not a waitlist form. Rendered to static markup to assert
 * the go-live wiring.
 */
const html = renderToStaticMarkup(createElement(LandingPage));

describe('LandingPage (go-live funnel)', () => {
  it('points every "Join the village" CTA at the app sign-up (not sign-in)', () => {
    expect(html).toContain('Join the village');
    expect(html).toContain(`href="${APP_URL}/sign-up"`);
    // Every "Join the village" anchor lands on sign-up — no join CTA drops into
    // sign-in. (The header "Log in" still points at sign-in; that is not a join.)
    const joinHrefs = [...html.matchAll(/href="([^"]*)"[^>]*>\s*Join the village/g)].map(
      (m) => m[1],
    );
    expect(joinHrefs.length).toBeGreaterThan(0);
    for (const href of joinHrefs) {
      expect(href).toBe(`${APP_URL}/sign-up`);
    }
  });

  it('leads the hero with the pre-auth value preview CTA', () => {
    expect(html).toContain(`href="${APP_URL}/preview"`);
    expect(html).toContain('See what Hale finds for you');
  });

  it('no longer wires any CTA to the waitlist anchor', () => {
    expect(html).not.toContain('href="#waitlist"');
  });

  it('removes the waitlist section from the landing', () => {
    expect(html).not.toContain('id="waitlist"');
    expect(html).not.toContain('join the waitlist');
  });

  it('carries no pre-launch "research preview" marking', () => {
    expect(html.toLowerCase()).not.toContain('research preview');
  });
});

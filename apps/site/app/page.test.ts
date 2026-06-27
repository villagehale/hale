import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import LandingPage from './page.js';

/**
 * At public launch the landing CTAs lead into the app's sign-in (then onboarding),
 * not a waitlist form. Rendered to static markup to assert the go-live wiring.
 */
const html = renderToStaticMarkup(createElement(LandingPage));

describe('LandingPage (go-live funnel)', () => {
  it('points the "Join the village" CTAs at the app sign-in', () => {
    expect(html).toContain(`href="${APP_URL}/sign-in"`);
    expect(html).toContain('Join the village');
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

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import AboutPage from '../app/about/page.js';
import ActivityCityRoute from '../app/activities/[city]/page.js';
import ActivitiesHub from '../app/activities/page.js';
import AnswerRoute from '../app/answers/[slug]/page.js';
import AnswersIndexPage from '../app/answers/page.js';
import ContactPage from '../app/contact/page.js';
import FaqPage from '../app/faq/page.js';
import LandingPage from '../app/page.js';
import PricingPage from '../app/pricing/page.js';
import { allCities } from '../lib/activities/index.js';
import { allAnswers } from '../lib/answers/index.js';

/**
 * One header and one footer, on every page.
 *
 * The fork this suite exists to prevent: a landing that ships its own chrome
 * while the subpages render different components — different nav, different
 * footer, a link pointing nowhere. These pin the v4 unification: every subpage's
 * <header> is byte-identical to the shared SiteHeader, every page ends in the one
 * shared <footer>, and the landing wears the SAME v4 glass nav pill (inline over
 * its shore hero) so a reader crossing from / to a subpage never changes products.
 */

const NUMBER = '+16475551234';

const firstCity = allCities[0];
const firstAnswer = allAnswers[0];
if (!firstCity || !firstAnswer) throw new Error('the dynamic routes have no content to render');

async function renderPage(page: () => unknown): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
  const element = await page();
  return renderToStaticMarkup(element as React.ReactElement);
}

/** Every page the shared chrome wraps, landing first. */
const PAGES: Record<string, () => unknown> = {
  '/': () => createElement(LandingPage),
  '/about': () => createElement(AboutPage),
  '/pricing': () => createElement(PricingPage),
  '/faq': () => createElement(FaqPage),
  '/contact': () => createElement(ContactPage),
  '/answers': () => createElement(AnswersIndexPage),
  '/answers/[slug]': () => AnswerRoute({ params: Promise.resolve({ slug: firstAnswer.slug }) }),
  '/activities': () => createElement(ActivitiesHub),
  '/activities/[city]': () =>
    ActivityCityRoute({ params: Promise.resolve({ city: firstCity.slug }) }),
};

const SUBPAGES = Object.keys(PAGES).filter((route) => route !== '/');

function chrome(html: string, tag: 'header' | 'footer'): string {
  const found = new RegExp(`<${tag}[\\s\\S]*</${tag}>`).exec(html)?.[0];
  if (!found) throw new Error(`no <${tag}> rendered`);
  return found;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('one header, one footer, every page', () => {
  it('renders the shared header on every subpage, byte-identical to SiteHeader', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
    const shared = chrome(renderToStaticMarkup(createElement(SiteHeader)), 'header');
    // The shared bar is a v4 glass nav pill — the design the whole site wears.
    expect(shared).toContain('class="v4-nav v4-glass"');

    for (const route of SUBPAGES) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      expect(chrome(await renderPage(page), 'header'), `${route} forked the header`).toBe(shared);
    }
  });

  it('wears the same v4 nav pill on the landing — inline over the hero, not the sticky bar', async () => {
    // The landing keeps its nav inline because it sits over the shore hero art, so
    // it is NOT byte-identical to the sticky shared bar. It is the same DEVICE,
    // though: a v4-nav glass pill whose logo goes home and which carries Text Hale.
    const shared = chrome(renderToStaticMarkup(createElement(SiteHeader)), 'header');
    const landingHeader = chrome(await renderPage(PAGES['/'] as () => unknown), 'header');
    expect(landingHeader).not.toBe(shared);
    expect(landingHeader).toContain('class="v4-nav v4-glass"');
    expect(landingHeader).toContain('aria-label="Hale, home"');
    expect(landingHeader).toContain('href="/"');
    expect(landingHeader).toContain('Text Hale');
  });

  it('renders the shared footer on every page — the landing included', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
    const shared = chrome(renderToStaticMarkup(createElement(SiteFooter)), 'footer');
    for (const route of Object.keys(PAGES)) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      expect(chrome(await renderPage(page), 'footer'), `${route} forked the footer`).toBe(shared);
    }
  });

  it('links "Features" from nowhere — there is no such page', async () => {
    // The old chrome carried a Features link whose href was '/', so it navigated
    // a reader from every subpage back to the homepage. A nav item with no
    // destination is deleted, not redirected.
    for (const route of Object.keys(PAGES)) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      const html = await renderPage(page);
      expect(html, `${route} still offers a Features link`).not.toContain('Features');
      // Positive control: the four links that DO have pages are all present.
      for (const label of ['About', 'Pricing', 'FAQ', 'Contact']) {
        expect(html, `${route} lost the ${label} link`).toContain(label);
      }
    }
  });
});

describe('the chrome carries the theme control', () => {
  it('keeps the theme control out of the header — v4 moves it to the footer', async () => {
    for (const route of ['/', '/pricing']) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      const header = chrome(await renderPage(page), 'header');
      expect(header, `${route} still carries a theme control in the bar`).not.toContain(
        'aria-label="Theme:',
      );
    }
  });

  it('puts the v4 two-state switch in the footer on the landing and on a subpage', async () => {
    for (const route of ['/', '/pricing']) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      const footer = chrome(await renderPage(page), 'footer');
      const sw = /<button type="button" role="switch"[\s\S]*?<\/button>/.exec(footer)?.[0] ?? '';
      expect(sw, `${route} has no theme switch`).toContain('class="v4-switch"');
      // Server-rendered, before the store is read, the switch reflects the default
      // (system, which resolves to the light frame) rather than a stored choice.
      expect(sw).toContain('aria-checked="false"');
      // It names where it is — the label is the honest current state, not a guess.
      expect(sw).toContain('>Light</span>');
    }
  });
});

describe('the footer says what the site is', () => {
  it('carries the brand lines and the two policy links, and no Legal column', async () => {
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    expect(footer).toContain('/HAH-leh/');
    expect(footer).toContain('Hawaiian for home');
    expect(footer).toContain('Village Hale Technologies Inc., Georgetown, Ontario');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/terms"');
    // Legal lives in the bottom bar only — a column would duplicate it.
    expect(footer).not.toContain('>Legal</h2>');
  });
});

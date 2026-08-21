import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import AboutPage from '../app/[locale]/about/page.js';
import ActivityCityRoute from '../app/[locale]/activities/[city]/page.js';
import ActivitiesHub from '../app/[locale]/activities/page.js';
import AnswerRoute from '../app/[locale]/answers/[slug]/page.js';
import AnswersIndexPage from '../app/[locale]/answers/page.js';
import ContactPage from '../app/[locale]/contact/page.js';
import FaqPage from '../app/[locale]/faq/page.js';
import LandingPage from '../app/[locale]/page.js';
import PricingPage from '../app/[locale]/pricing/page.js';
import { allCities } from '../lib/activities/index.js';
import { allAnswers } from '../lib/answers/index.js';

/**
 * One header and one footer, on every page.
 *
 * The fork this suite exists to prevent: a landing that ships its own chrome
 * while the subpages render different components — different nav, different
 * footer, a link pointing nowhere. These pin the v4 unification: EVERY page's
 * <header> is byte-identical to the shared SiteHeader, the landing included, and
 * every page ends in the one shared <footer>.
 *
 * The landing used to render its own inline copy of the pill inside the hero, so
 * the bar scrolled away on the one page a reader spends longest on and the two
 * headers could drift apart line by line. It now renders the shared sticky bar
 * and keeps the over-hero look in CSS instead (.v4-hero-top pulls the hero up
 * under it) — one header, one behaviour, whole site (founder, 2026-08-19).
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
const EN = { locale: 'en' as const };

const PAGES: Record<string, () => unknown> = {
  '/': () => LandingPage({ params: Promise.resolve(EN) }),
  '/about': () => AboutPage({ params: Promise.resolve(EN) }),
  '/pricing': () => PricingPage({ params: Promise.resolve(EN) }),
  '/faq': () => FaqPage({ params: Promise.resolve(EN) }),
  '/contact': () => ContactPage({ params: Promise.resolve(EN) }),
  '/answers': () => AnswersIndexPage({ params: Promise.resolve(EN) }),
  '/answers/[slug]': () =>
    AnswerRoute({ params: Promise.resolve({ slug: firstAnswer.slug, ...EN }) }),
  '/activities': () => ActivitiesHub({ params: Promise.resolve(EN) }),
  '/activities/[city]': () =>
    ActivityCityRoute({ params: Promise.resolve({ city: firstCity.slug, ...EN }) }),
};

const ROUTES = Object.keys(PAGES);

function chrome(html: string, tag: 'header' | 'footer'): string {
  const found = new RegExp(`<${tag}[\\s\\S]*</${tag}>`).exec(html)?.[0];
  if (!found) throw new Error(`no <${tag}> rendered`);
  return found;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('one header, one footer, every page', () => {
  it('renders the shared header on every page, landing included, byte-identical to SiteHeader', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
    const shared = chrome(renderToStaticMarkup(createElement(SiteHeader)), 'header');
    // The shared bar is a v4 glass nav pill — the design the whole site wears —
    // and it is sticky, so it is still there when a reader is deep in the page.
    expect(shared).toContain('class="v4-nav v4-glass"');
    expect(shared).toContain('sticky top-0');

    for (const route of ROUTES) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      expect(chrome(await renderPage(page), 'header'), `${route} forked the header`).toBe(shared);
    }
  });

  it('keeps the landing hero under that bar rather than below it', async () => {
    // The over-hero look survives the unification in CSS, not in a second header:
    // the hero is pulled up by the bar's own height and padded back by the same
    // amount, so the shore still starts at the top of the viewport.
    const landing = await renderPage(PAGES['/'] as () => unknown);
    expect(landing).toContain('v4-hero v4-hero-top');
    const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
    expect(css).toContain('margin-top: calc(-1 * var(--nav-h));');
    expect(css).toContain('padding-top: var(--nav-h);');
  });

  it('takes 10–15px of block height out of the pill on a phone, and off --nav-h with it', () => {
    // Founder, 2026-08-20. The bar is fixed over the one thing a phone reader has
    // least of, so it gives some height back below 640px — and the reservation the
    // landing hero runs under (--nav-h) has to give back EXACTLY the same amount
    // or the shore stops meeting the top of the viewport. One number moving
    // without the other is the failure this pin exists for, which is why it
    // asserts the two deltas are equal rather than asserting either value.
    const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
    const REM = 16;
    const rem = (value: string) => Number(value.replace('rem', '')) * REM;
    /** Rendered block height of the pill: its own padding, plus the tallest thing
     * in it — the CTA button, whose own box is its padding plus one line of
     * inherited body leading. */
    const pill = (navPadBlock: number, btnPadBlock: number) =>
      2 * navPadBlock + 2 * btnPadBlock + rem('0.92rem') * 1.65;

    const desktop = pill(rem('0.6rem'), rem('0.7rem'));
    const phone = pill(rem('0.35rem'), rem('0.55rem'));
    expect(css).toContain('padding: 0.6rem 0.7rem 0.6rem 1.15rem;');
    expect(css).toMatch(/\.v4-nav \{ padding-block: 0\.35rem; \}/);
    expect(css).toMatch(/\.v4-btn-solid \{ padding-block: 0\.55rem; \}/);
    expect(css).toMatch(/font-size: 0\.92rem;/);

    const shaved = desktop - phone;
    expect(shaved).toBeGreaterThanOrEqual(10);
    expect(shaved).toBeLessThanOrEqual(15);
    expect(rem('5.4rem') - rem('4.6rem')).toBeCloseTo(shaved, 1);
    // …and the reduction is a phone-only override, not the new value everywhere.
    expect(css).toMatch(/@media \(max-width: 639\.98px\) \{\s*:root \{ --nav-h: 4\.6rem; \}/);
    expect(css).toMatch(/--nav-h: 5\.4rem;/);
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

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
 * The fork this suite exists to prevent: the v3 landing shipped its own inline
 * header and footer while eight subpages went on rendering the old components —
 * different nav, different footer, no dark mode, and a "Features" link pointing
 * at the homepage. Nothing failed, because no test compared one page's chrome to
 * another's. These do: every page's <header> must be byte-identical to the shared
 * component's own output, so a bespoke re-fork cannot pass.
 */

const NUMBER = '+16475551234';

/** The landing's one variation: `sms:` is dead on a laptop, so its desktop pill
 * scrolls to the hero CTA block instead. */
const LANDING_SCROLL_TARGET = 'start';

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
  it('renders the shared header on every page — the landing included', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
    const shared = chrome(renderToStaticMarkup(createElement(SiteHeader)), 'header');
    const landingHeader = chrome(
      renderToStaticMarkup(createElement(SiteHeader, { scrollTargetId: LANDING_SCROLL_TARGET })),
      'header',
    );
    // Positive control: the two shapes ARE different, so matching a page against
    // the wrong one below would fail rather than pass by coincidence.
    expect(landingHeader).not.toBe(shared);

    for (const route of SUBPAGES) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      expect(chrome(await renderPage(page), 'header'), `${route} forked the header`).toBe(shared);
    }
    expect(chrome(await renderPage(PAGES['/'] as () => unknown), 'header')).toBe(landingHeader);
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

describe('the chrome carries the theme controls', () => {
  it('puts the cycle button in the header on the landing and on a subpage', async () => {
    for (const route of ['/', '/pricing']) {
      const page = PAGES[route];
      if (!page) throw new Error(route);
      const header = chrome(await renderPage(page), 'header');
      expect(header, `${route} has no theme control`).toContain('aria-label="Theme:');
      // Both glyphs ship; CSS picks. That is what makes the button correct in the
      // first painted frame rather than after hydration.
      expect(header).toContain('theme-icon-light');
      expect(header).toContain('theme-icon-dark');
    }
  });

  it('offers the named three-way in the footer, beside the brand line', async () => {
    const page = PAGES['/about'];
    if (!page) throw new Error('/about');
    const footer = chrome(await renderPage(page), 'footer');
    const choice = /<fieldset class="theme-choice"[\s\S]*?<\/fieldset>/.exec(footer)?.[0] ?? '';
    for (const option of ['Light', 'Dark', 'System']) {
      expect(choice, `the three-way is missing ${option}`).toContain(`>${option}</button>`);
    }
    // Exactly one is current, and it is announced as pressed rather than by
    // colour alone. Server-rendered that is the default, `system`.
    expect([...footer.matchAll(/aria-pressed="true"/g)]).toHaveLength(1);
    expect([...footer.matchAll(/aria-pressed="false"/g)]).toHaveLength(2);
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

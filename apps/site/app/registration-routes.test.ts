import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { localeHref } from '~/i18n/navigation.js';
import { routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import ActivitiesHub from './[locale]/activities/page.js';
import BramptonPage from './[locale]/brampton-swim-registration/page.js';
import TorontoFallPage from './[locale]/toronto-fall-recreation-registration/page.js';
import TorontoSwimPage from './[locale]/toronto-swim-registration/page.js';
import YmcaPage from './[locale]/ymca-gta-swim-registration/page.js';
import sitemap from './sitemap.js';

/**
 * The four dated city registration guides are retired. Each URL 308s to that
 * locale's activities hub, and nothing on the site still links to them.
 */

const GUIDES = [
  { slug: 'toronto-fall-recreation-registration', Page: TorontoFallPage },
  { slug: 'toronto-swim-registration', Page: TorontoSwimPage },
  { slug: 'brampton-swim-registration', Page: BramptonPage },
  { slug: 'ymca-gta-swim-registration', Page: YmcaPage },
] as const;

describe('dated city registration guides redirect to the activities hub', () => {
  it.each(routing.locales)('308s every guide for %s', async (locale) => {
    const dest = localeHref(locale, '/activities');
    for (const { slug, Page } of GUIDES) {
      try {
        await Page({ params: Promise.resolve({ locale }) });
        throw new Error(`expected a redirect for ${slug}`);
      } catch (error) {
        const digest = String((error as { digest?: unknown }).digest);
        expect(digest, `${locale}/${slug}`).toBe(`NEXT_REDIRECT;replace;${dest};308;`);
      }
    }
  });

  it('keeps the guides out of the sitemap and off the activities hub', async () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/activities`);
    for (const { slug } of GUIDES) {
      expect(urls.filter((url) => url.includes(slug))).toEqual([]);
    }
    for (const locale of routing.locales) {
      const html = renderToStaticMarkup(
        await ActivitiesHub({ params: Promise.resolve({ locale }) }),
      );
      for (const { slug } of GUIDES) {
        expect(html).not.toContain(slug);
      }
    }
  });
});

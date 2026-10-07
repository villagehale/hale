import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { localeHref } from '~/i18n/navigation.js';
import { routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import sitemap from '../../../sitemap.js';
import ActivityCityRedirect, { RETIRED_CITY_SLUGS } from './page.js';

/**
 * /activities/<city> is retired. The URL 308s to that locale's activities hub.
 * Registration guides (Toronto fall, Toronto swim, Brampton swim, YMCA) are
 * their own routes and stay.
 */

describe('/activities/[city] redirects to the hub', () => {
  it.each(routing.locales)('308s every retired city to %s /activities', async (locale) => {
    const dest = localeHref(locale, '/activities');
    for (const city of RETIRED_CITY_SLUGS) {
      try {
        await ActivityCityRedirect({ params: Promise.resolve({ locale, city }) });
        throw new Error(`expected a redirect for ${city}`);
      } catch (error) {
        const digest = String((error as { digest?: unknown }).digest);
        expect(digest, `${locale}/${city}`).toBe(`NEXT_REDIRECT;replace;${dest};308;`);
      }
    }
  });

  it('404s a city that was never a guide', async () => {
    try {
      await ActivityCityRedirect({
        params: Promise.resolve({ locale: 'en', city: 'halifax' }),
      });
      throw new Error('expected notFound');
    } catch (error) {
      const digest = String((error as { digest?: unknown }).digest);
      expect(digest.startsWith('NEXT_REDIRECT')).toBe(false);
      expect(digest).toContain('404');
    }
  });

  it('keeps city URLs out of the sitemap and the footer', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/activities`);
    for (const city of RETIRED_CITY_SLUGS) {
      expect(urls.filter((url) => url.includes(`/activities/${city}`))).toEqual([]);
    }
    const footer = renderToStaticMarkup(createElement(SiteFooter, { locale: 'en' }));
    expect(footer).toContain('href="/activities"');
    for (const city of RETIRED_CITY_SLUGS) {
      expect(footer).not.toContain(`/activities/${city}`);
    }
  });
});

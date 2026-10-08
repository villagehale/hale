import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import sitemap from '../../sitemap.js';
import { GET as llms } from '../../llms.txt/route.js';
import ContactPage from '../contact/page.js';
import ForCentresPage from './page.js';

/**
 * /for-centres is retired. The URL redirects home in the reader's language.
 * The family question that used to live here ("Is Hale official?") is on /faq.
 */

function isRedirect(error: unknown): boolean {
  return String((error as { digest?: unknown })?.digest ?? '').startsWith('NEXT_REDIRECT');
}

describe('/for-centres redirects home', () => {
  it.each(routing.locales)('sends %s home', async (locale) => {
    try {
      await ForCentresPage({ params: Promise.resolve({ locale }) });
      throw new Error('expected a redirect');
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      const digest = String((error as { digest?: unknown }).digest);
      const home = locale === 'en' ? '/' : `/${locale}`;
      expect(digest).toContain(home);
    }
  });

  it('is absent from the sitemap, the footer, contact, and llms.txt', async () => {
    expect(sitemap().map((entry) => entry.url)).not.toContain(`${SITE_URL}/for-centres`);
    const en = renderToStaticMarkup(createElement(SiteFooter, { locale: 'en' }));
    const fr = renderToStaticMarkup(createElement(SiteFooter, { locale: 'fr' }));
    expect(en).not.toContain('for-centres');
    expect(fr).not.toContain('for-centres');
    const contact = renderToStaticMarkup(
      await ContactPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(contact).not.toContain('/for-centres');
    expect(await llms().text()).not.toContain('/for-centres');
  });
});

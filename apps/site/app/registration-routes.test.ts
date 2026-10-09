import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import { localeHref } from '~/i18n/navigation.js';
import { routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import {
  RETIRED_REGISTRATION_GUIDES,
  RETIRED_REGISTRATION_LOCALE_PREFIXES,
  retiredRegistrationRedirects,
} from '~/lib/site/retired-registration-redirects.js';
import nextConfig from '~/next.config';
import ActivitiesHub from './[locale]/activities/page.js';
import sitemap from './sitemap.js';

/**
 * The four dated city registration guides are retired. Each URL 308s to that
 * locale's activities hub (`permanent: true` in next.config), including the
 * /fr and /zh prefixes and the trailing-slash spelling. The destination carries
 * no query of its own, which is how Next keeps the request's query string.
 *
 * trailingSlash stays off, so Next also 308s `/:path+/` to `/:path+` before
 * these rules. The slash source is the same forward if that hop is skipped.
 */

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const DELETED = [
  'app/[locale]/toronto-fall-recreation-registration/page.tsx',
  'app/[locale]/toronto-swim-registration/page.tsx',
  'app/[locale]/brampton-swim-registration/page.tsx',
  'app/[locale]/ymca-gta-swim-registration/page.tsx',
  'components/registration-page.tsx',
  'components/product-faq-accordion.tsx',
  'components/cta-band.tsx',
  'components/landing/fade-in-up.tsx',
  'lib/registration/guides.ts',
  'lib/registration/index.ts',
  'lib/registration/types.ts',
  'lib/registration/structured-data.ts',
  'lib/registration/structured-data.test.ts',
  'lib/registration/registration.test.ts',
] as const;

async function redirects() {
  if (typeof nextConfig.redirects !== 'function') {
    throw new Error('next.config has no redirects()');
  }
  return nextConfig.redirects();
}

function sourcesFor(slug: string): Array<{ source: string; locale: (typeof routing.locales)[number] }> {
  return routing.locales.flatMap((locale) => {
    const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
    return (['', '/'] as const).map((slash) => ({
      locale,
      source: `${prefix}/${slug}${slash}`,
    }));
  });
}

describe('dated city registration guides redirect to the activities hub', () => {
  it('covers exactly the locales the site serves, English unprefixed', () => {
    expect(routing.locales).toEqual(['en', ...RETIRED_REGISTRATION_LOCALE_PREFIXES]);
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('as-needed');
  });

  it('308s every guide, in every locale, with and without a trailing slash', async () => {
    const rules = await redirects();
    expect(rules).toEqual(retiredRegistrationRedirects());
    for (const slug of RETIRED_REGISTRATION_GUIDES) {
      for (const { source, locale } of sourcesFor(slug)) {
        const rule = rules.find((entry) => entry.source === source);
        const destination = localeHref(locale, '/activities');
        expect(rule, source).toMatchObject({ destination, permanent: true });
        // A destination with its own query would replace the request's.
        expect(rule?.destination, source).not.toContain('?');
      }
    }
  });

  it('does not turn off the built-in trailing-slash 308', () => {
    expect(nextConfig.trailingSlash).toBeFalsy();
    expect(nextConfig.skipTrailingSlashRedirect).toBeFalsy();
  });

  it('keeps the guides out of the sitemap', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/activities`);
    for (const slug of RETIRED_REGISTRATION_GUIDES) {
      expect(urls.filter((url) => url.includes(slug))).toEqual([]);
    }
  });

  it('keeps the guides out of the activities hub, header, and footer', async () => {
    for (const locale of routing.locales) {
      const html = [
        renderToStaticMarkup(await ActivitiesHub({ params: Promise.resolve({ locale }) })),
        renderToStaticMarkup(createElement(SiteHeader, { locale })),
        renderToStaticMarkup(createElement(SiteFooter, { locale })),
      ].join('\n');
      for (const slug of RETIRED_REGISTRATION_GUIDES) {
        expect(html, `${locale} ${slug}`).not.toContain(slug);
      }
    }
  });

  it('leaves no guide slug in site source outside the redirect table and tests', () => {
    const skip = new Set([
      fileURLToPath(new URL('../lib/site/retired-registration-redirects.ts', import.meta.url)),
    ]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|json|css)$/.test(entry.name) || entry.name.includes('.test.')) continue;
        if (skip.has(full)) continue;
        const text = readFileSync(full, 'utf8');
        for (const slug of RETIRED_REGISTRATION_GUIDES) {
          if (text.includes(slug)) hits.push(`${full} — ${slug}`);
        }
      }
    };
    walk(SITE_ROOT);
    expect(hits).toEqual([]);
  });

  it('drops the Registration message namespace in every locale', () => {
    for (const locale of routing.locales) {
      const bundle = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
      ) as { Registration?: unknown };
      expect(bundle.Registration, locale).toBeUndefined();
    }
  });

  it.each(DELETED)('%s no longer exists', (rel) => {
    expect(existsSync(join(SITE_ROOT, rel))).toBe(false);
  });
});

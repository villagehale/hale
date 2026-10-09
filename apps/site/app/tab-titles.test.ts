import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { homeMetadata } from '~/lib/site/home-meta.js';
import { notFoundHeading, notFoundMetadata, notFoundTitle } from '~/lib/site/not-found-copy.js';
import { generateMetadata as catchAllMetadata } from './[locale]/[...rest]/page.js';
import { generateMetadata as aboutMetadata } from './[locale]/about/page.js';
import { generateMetadata as guideMetadata } from './[locale]/answers/[slug]/page.js';
import { generateMetadata as answersMetadata } from './[locale]/answers/page.js';
import { generateMetadata as contactMetadata } from './[locale]/contact/page.js';
import { NotFoundView, generateMetadata as notFoundMetadataFn } from './[locale]/not-found.js';
import { generateMetadata as textMetadata } from './[locale]/text/page.js';

const headerLocale = vi.hoisted(() => ({ value: 'en' as string | null }));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'x-next-intl-locale' ? headerLocale.value : null),
  }),
}));

/**
 * Approved tab titles. The homepage title is also the og and twitter title.
 * A page body must not print its own <title>: metadata is the only one.
 */

const HOME_TITLES = {
  en: 'Hale · Your kids’ year, handled.',
  fr: 'Hale · L’année de tes enfants, sans casse-tête.',
  zh: '孩子这一年，交给 Hale',
} as const;

const NOT_FOUND_TITLES = {
  en: 'Page not found · Hale',
  fr: 'Page introuvable · Hale',
  zh: '找不到这个页面 · Hale',
} as const;

function inlineTitles(html: string): string[] {
  return html.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) ?? [];
}

describe('homepage tab titles', () => {
  it('sets title, og:title, and twitter:title to the approved string in each locale', () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      const meta = homeMetadata(locale);
      expect(meta.title, locale).toBe(HOME_TITLES[locale]);
      expect(meta.openGraph?.title, locale).toBe(HOME_TITLES[locale]);
      expect((meta.twitter as { title?: string } | undefined)?.title, locale).toBe(
        HOME_TITLES[locale],
      );
      expect(typeof meta.title).toBe('string');
    }
  });

  it('does not install a title template that would suffix titles twice', () => {
    const layout = readFileSync(
      fileURLToPath(new URL('./[locale]/layout.tsx', import.meta.url)),
      'utf8',
    );
    expect(layout).not.toContain('template:');
    expect(layout).toContain('homeMetadata(locale)');
  });
});

describe('pages that used to inherit the homepage preview', () => {
  it('gives about, contact, answers, and text their own og and twitter titles', async () => {
    const pages = [
      ['/about', aboutMetadata, 'About · Hale'],
      ['/contact', contactMetadata, 'Contact · Hale'],
      ['/answers', answersMetadata, 'Parenting guides · Hale'],
      ['/text', textMetadata, 'Text Hale'],
    ] as const;
    for (const [path, generate, title] of pages) {
      const meta = await generate({ params: Promise.resolve({ locale: 'en' as const }) });
      expect(meta.title, path).toBe(title);
      expect(meta.openGraph?.title, path).toBe(title);
      expect((meta.twitter as { title?: string } | undefined)?.title, path).toBe(title);
      expect(meta.openGraph && 'url' in meta.openGraph ? meta.openGraph.url : undefined).toBe(path);
      expect(String(meta.title)).not.toBe(HOME_TITLES.en);
    }
  });
});

describe('404 tab titles', () => {
  it('uses the translated title in each locale, and the body adds no second title', async () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      expect(notFoundTitle(locale)).toBe(NOT_FOUND_TITLES[locale]);
      expect(notFoundMetadata(locale).title).toBe(NOT_FOUND_TITLES[locale]);
      const html = renderToStaticMarkup(createElement(NotFoundView, { locale }));
      expect(inlineTitles(html), locale).toEqual([]);
      expect(html).toContain(notFoundHeading(locale));
      expect(html).not.toContain(HOME_TITLES[locale]);

      headerLocale.value = locale;
      const fromHeader = await notFoundMetadataFn();
      expect(fromHeader.title, locale).toBe(NOT_FOUND_TITLES[locale]);

      const fromCatchAll = await catchAllMetadata({
        params: Promise.resolve({ locale }),
      });
      expect(fromCatchAll.title, locale).toBe(NOT_FOUND_TITLES[locale]);
    }
  });

  it('returns the 404 title for an unknown guide slug in each locale', async () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      const meta = await guideMetadata({
        params: Promise.resolve({ locale, slug: 'not-a-real-guide' }),
      });
      expect(meta.title, locale).toBe(NOT_FOUND_TITLES[locale]);
      expect(typeof meta.title).toBe('string');
    }
  });
});

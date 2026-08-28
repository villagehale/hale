import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { buildAlternates } from '~/i18n/metadata.js';
import { LOCALE_NAMES, localeHref, stripLocalePrefix } from '~/i18n/navigation.js';
import { routing } from '~/i18n/routing.js';
import { FAQ } from '~/lib/faq/index.js';
import { generateMetadata as aboutMetadata } from './[locale]/about/page.js';

/**
 * The internationalization contract for the marketing site (feat/site-i18n):
 * three locales, English unprefixed, French and Chinese under /fr and /zh, with
 * hreflang alternates on every page and a footer selector that preserves the path.
 * Hard invariant: the phone number never appears as literal text anywhere,
 * messages included (it lives only in `sms:` links and the copy button).
 */

describe('routing config', () => {
  it('serves three locales, English as the unprefixed default', () => {
    expect(routing.locales).toEqual(['en', 'fr', 'zh']);
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('as-needed');
    // The URL is the only source of language — no cookie, no Accept-Language
    // redirect off `/`.
    expect(routing.localeCookie).toBe(false);
    expect(routing.localeDetection).toBe(false);
  });
});

describe('localeHref — the default stays unprefixed, others carry a prefix', () => {
  it('leaves every English URL exactly where it was', () => {
    expect(localeHref('en', '/')).toBe('/');
    expect(localeHref('en', '/about')).toBe('/about');
    expect(localeHref('en', '/answers/introducing-peanuts-to-baby')).toBe(
      '/answers/introducing-peanuts-to-baby',
    );
  });

  it('prefixes French and Chinese', () => {
    expect(localeHref('fr', '/')).toBe('/fr');
    expect(localeHref('fr', '/about')).toBe('/fr/about');
    expect(localeHref('zh', '/pricing')).toBe('/zh/pricing');
    expect(localeHref('zh', '/')).toBe('/zh');
  });

  it('round-trips with stripLocalePrefix, which is how the selector preserves the path', () => {
    for (const locale of routing.locales) {
      for (const path of ['/', '/about', '/activities/toronto']) {
        expect(stripLocalePrefix(localeHref(locale, path))).toBe(path);
      }
    }
  });
});

describe('hreflang alternates', () => {
  it('buildAlternates emits every locale plus x-default, with the rendered locale canonical', () => {
    const alt = buildAlternates('fr', '/pricing');
    expect(alt.canonical).toBe('/fr/pricing');
    expect(alt.languages).toEqual({
      en: '/pricing',
      fr: '/fr/pricing',
      zh: '/zh/pricing',
      'x-default': '/pricing',
    });
  });

  it('every page emits alternates.languages via generateMetadata', async () => {
    for (const locale of routing.locales) {
      const meta = await aboutMetadata({ params: Promise.resolve({ locale }) });
      expect(meta.alternates?.canonical).toBe(localeHref(locale, '/about'));
      const languages = meta.alternates?.languages ?? {};
      for (const l of routing.locales) {
        expect(languages[l]).toBe(localeHref(l, '/about'));
      }
      expect(languages['x-default']).toBe('/about');
    }
  });
});

describe('the footer language selector', () => {
  it('offers every locale, named in its own language, with the current one selected', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter, { locale: 'fr' }));
    for (const locale of routing.locales) {
      expect(html).toContain(`value="${locale}"`);
      expect(html).toContain(LOCALE_NAMES[locale]);
    }
    // The rendered (current) locale is the one selected — the switch reflects where
    // you are, and stripLocalePrefix + localeHref (tested above) re-prefix the live
    // path on change.
    const frOption = html.match(/<option[^>]*value="fr"[^>]*>/)?.[0] ?? '';
    expect(frOption).toContain('selected');
  });

  it('is locale-aware in its own links — a French footer points at French URLs', () => {
    const fr = renderToStaticMarkup(createElement(SiteFooter, { locale: 'fr' }));
    expect(fr).toContain('href="/fr/pricing"');
    expect(fr).toContain('href="/fr/privacy"');
    // Positive control: the English footer keeps the bare paths.
    const en = renderToStaticMarkup(createElement(SiteFooter, { locale: 'en' }));
    expect(en).toContain('href="/pricing"');
    expect(en).not.toContain('href="/fr/pricing"');
  });
});

describe('the phone number is never literal text — messages included (hard rule #1)', () => {
  const files = ['en', 'fr', 'zh'].map((l) => ({
    locale: l,
    raw: readFileSync(fileURLToPath(new URL(`../messages/${l}.json`, import.meta.url)), 'utf8'),
  }));

  it('has substantial message bundles (positive control for the absence checks)', () => {
    for (const { locale, raw } of files) {
      expect(raw.length, `${locale}.json should be a real bundle`).toBeGreaterThan(1000);
    }
  });

  it('carries no homepage question chips in any locale', () => {
    // Designer lock 2026-08-27 chips/prefill — the four first-text questions
    // are gone from the homepage, including FR/ZH mirrors. An empty chips
    // array would still be a clickable row if the UI read it.
    for (const { locale, raw } of files) {
      const bundle = JSON.parse(raw) as { Landing?: { chips?: unknown } };
      expect(bundle.Landing?.chips, `${locale}.json must not keep Landing.chips`).toBeUndefined();
      expect(raw, `${locale}.json must not keep swim-registration chip copy`).not.toContain(
        'When does swim registration open near me?',
      );
    }
  });

  it('carries no phone-number digits in any grouping', () => {
    const groupings = [
      '+16475551234',
      '6475551234',
      '647-555-1234',
      '(647) 555-1234',
      '(647)',
      '555-1234',
    ];
    for (const { locale, raw } of files) {
      // A run of 7+ digits is a phone number; short numbers in copy (0–18, 100
      // families, 15 municipalities) are fine.
      expect(raw, `${locale}.json must hold no phone-length digit run`).not.toMatch(/\d{7,}/);
      for (const grouping of groupings) {
        expect(raw, `${locale}.json must not contain ${grouping}`).not.toContain(grouping);
      }
    }
  });
});

describe('the FAQ translation source mirrors the canonical English list', () => {
  it('en.json Faq.items matches lib/faq so translations descend from the shipped copy', () => {
    const en = JSON.parse(
      readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'),
    );
    expect(en.Faq.items).toEqual(FAQ.map((item) => ({ question: item.question, answer: item.answer })));
  });
});

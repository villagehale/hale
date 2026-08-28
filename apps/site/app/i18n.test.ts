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
import AboutPage from './[locale]/about/page.js';
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

describe('VIL-325 designer-locked intake copy — homepage steps and About.cta', () => {
  const bundles = Object.fromEntries(
    (['en', 'fr', 'zh'] as const).map((locale) => [
      locale,
      JSON.parse(
        readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
      ),
    ]),
  );

  it('pins English Landing.steps[0] and About.cta exactly', () => {
    expect(bundles.en.Landing.steps[0]).toEqual({
      when: 'Right now',
      step: 'You text names, ages, and a postal code',
      body: 'One text. No app, no account.',
    });
    expect(bundles.en.About.cta).toBe(
      'It starts with names, ages, and a postal code. No app, no account.',
    );
    expect(bundles.en.Landing.threadLede).toContain('no menus');
    expect(JSON.stringify(bundles.en.Landing.steps[0])).not.toMatch(/You say hi|no forms/i);
    expect(bundles.en.About.cta).not.toMatch(/no form/i);
  });

  it('mirrors the same keys in FR and ZH without inventing extra English', () => {
    expect(bundles.fr.Landing.steps[0]).toEqual({
      when: 'Tout de suite',
      step: 'Vous textez les noms, les âges et un code postal',
      body: 'Un texto. Pas d’appli, pas de compte.',
    });
    expect(bundles.fr.About.cta).toBe(
      'Ça commence par les noms, les âges et un code postal. Pas d’appli, pas de compte.',
    );
    expect(bundles.zh.Landing.steps[0]).toEqual({
      when: '现在就可以',
      step: '你发来名字、年龄和一个邮编',
      body: '一条短信就行。不用装应用，不用注册账号。',
    });
    expect(bundles.zh.About.cta).toBe('一切从名字、年龄和一个邮编开始。不用装应用，不用注册账号。');
  });

  it('renders the locked About.cta on /about', async () => {
    const html = renderToStaticMarkup(
      await AboutPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).toContain('It starts with names, ages, and a postal code. No app, no account.');
    expect(html).not.toContain('It starts with one text');
  });
});

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

describe('no bundle promises quiet, in any locale', () => {
  const files = (['en', 'fr', 'zh'] as const).map((locale) => ({
    locale,
    raw: readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
  }));

  /**
   * A REGRESSION PIN, not a general rule about the word.
   *
   * These four promises — the hero sub's "Three texts, then quiet", the cadence
   * FAQ's "It is quiet in between", the /about ladder's "Quiet in between" and
   * /for-centres' "Then it goes quiet:" — each said Hale goes silent between the
   * things it names, and each named only the registration ladder. The evening
   * check-in is merged and tested and asks EVERY night at 20:00 local, stepping
   * down to weekly only after three unanswered evenings; one F14 flip and all
   * four are false for every family that answers.
   *
   * A clause that promises quiet AND names the evening ask in the same breath is
   * honest and is deliberately not covered here — the fix for those is copy that
   * tells the whole cadence, which is a different change from this subtraction.
   */
  const REMOVED: Record<string, string[]> = {
    en: ['then quiet', 'quiet in between', 'then it goes quiet'],
    fr: ['puis le silence', 'le silence entre les deux', 'ensuite, c’est tranquille'],
    zh: ['之后便安静', '安安静静', '之后就安静下来'],
  };

  it('never says any of the four quiet promises again', () => {
    for (const { locale, raw } of files) {
      for (const phrase of REMOVED[locale] ?? []) {
        expect(raw.toLowerCase(), `${locale}.json must not say "${phrase}"`).not.toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  it('claims no Sunday brief in any locale — that one needs a SECOND flag', () => {
    // Same shape as the quiet promise, same reason: the Sunday text's SEND is
    // gated by LOOP_SEND_ENABLED (default OFF) on top of F14, so it is a
    // separate release event and no surface may describe it in the present
    // tense yet. Named per locale because "Sunday" is not the word in two of
    // the three.
    const SUNDAY: Record<string, string[]> = {
      en: ['sunday'],
      fr: ['dimanche'],
      zh: ['周日', '星期日'],
    };
    for (const { locale, raw } of files) {
      for (const phrase of SUNDAY[locale] ?? []) {
        expect(raw.toLowerCase(), `${locale}.json must not claim "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('positive control: every bundle still says what Hale DOES send', () => {
    // The subtraction must leave the cadence described, not the page silent about
    // it — otherwise these absences would also pass on an empty bundle.
    const say = { en: 'a heads-up the week a registration opens', fr: 'une inscription ouvre', zh: '报名开放' };
    for (const { locale, raw } of files) {
      expect(raw.toLowerCase()).toContain(say[locale].toLowerCase());
    }
  });
});

describe('the positioning noun is gone from every bundle', () => {
  const files = (['en', 'fr', 'zh'] as const).map((locale) => ({
    locale,
    raw: readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
  }));

  /**
   * "Family assistant" is the category the pre-F14 site sold. It is not what the
   * product says about itself: the live intake greeting and /for-centres both
   * describe the loop — it finds what is on, it watches the sign-up morning, it
   * comes back and asks how it went — with no "assistant" in them. The site was
   * behind its own machine, not ahead of it.
   *
   * The ban is on the POSITIONING PHRASE, never on the word: the anti-scam
   * disclosure ("Hale is an AI assistant, and it never pretends otherwise") is a
   * different sentence doing a different job, and it survives. A phrase-level ban
   * is what lets one gate hold both facts at once.
   */
  const BANNED: Record<string, string[]> = {
    en: ['family assistant'],
    fr: ['assistant familial'],
    zh: ['家庭助手', '家庭助理'],
  };

  it('never sells a "family assistant" in any locale', () => {
    for (const { locale, raw } of files) {
      for (const phrase of BANNED[locale] ?? []) {
        expect(raw.toLowerCase(), `${locale}.json must not say "${phrase}"`).not.toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  it('positive control: the AI disclosure the ban must not reach is still there', () => {
    const en = files.find((f) => f.locale === 'en')?.raw ?? '';
    expect(en).toContain('Hale is an AI assistant, and it never pretends otherwise.');
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

describe('VIL-325 designer-locked intake copy — the first-text sentence and About.cta', () => {
  const bundles = Object.fromEntries(
    (['en', 'fr', 'zh'] as const).map((locale) => [
      locale,
      JSON.parse(
        readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
      ),
    ]),
  );

  /**
   * The founder locked a SENTENCE, not an array index.
   *
   * It was pinned as `Landing.steps[0]`, an object in a three-step card grid that
   * v5 retired — the sequence is the hero's spine now. So the pin follows the
   * words into the how-it-works prose rather than dying with the array: what is
   * locked is that the first text is names, ages and a postal code (never "hi"),
   * that there is no app and no account, and that the thread has no menus. A pin
   * on where the sentence sat would have made a layout change look like a
   * founder decision being overturned.
   */
  const LOCKED: Record<string, string[]> = {
    en: ['You text names, ages, and a postal code', 'No app, no account.', 'no menus'],
    fr: ['les noms, les âges et un code postal', 'Pas d’appli, pas de compte.', 'pas de menus'],
    zh: ['名字、年龄和一个邮编', '不用装应用，不用注册账号。', '没有菜单'],
  };

  it('keeps the locked words in the Landing namespace of every locale', () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      const landing = JSON.stringify(bundles[locale].Landing);
      for (const phrase of LOCKED[locale] ?? []) {
        expect(landing, `${locale}.Landing must still say "${phrase}"`).toContain(phrase);
      }
      expect(landing, `${locale} must not reopen "you say hi"`).not.toMatch(/You say hi|dites bonjour/i);
    }
    expect(JSON.stringify(bundles.en.Landing)).not.toMatch(/no forms/i);
  });

  it('pins About.cta exactly, in all three locales', () => {
    expect(bundles.en.About.cta).toBe(
      'It starts with names, ages, and a postal code. No app, no account.',
    );
    expect(bundles.fr.About.cta).toBe(
      'Ça commence par les noms, les âges et un code postal. Pas d’appli, pas de compte.',
    );
    expect(bundles.zh.About.cta).toBe('一切从名字、年龄和一个邮编开始。不用装应用，不用注册账号。');
    expect(bundles.en.About.cta).not.toMatch(/no form/i);
  });

  it('renders the locked About.cta on /about', async () => {
    const html = renderToStaticMarkup(
      await AboutPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).toContain('It starts with names, ages, and a postal code. No app, no account.');
    expect(html).not.toContain('It starts with one text');
  });
});

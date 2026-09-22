import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities.js';
import LandingPage from './[locale]/page.js';

/**
 * The registration loop is the landing's product shot, and it is the one section
 * whose copy is a per-locale ARRAY — a translator who drops a row silently
 * shortens the story rather than throwing. next-intl's `t.raw` returns whatever
 * the bundle holds, so nothing else in the suite would notice.
 *
 * This renders all three locales and asserts the loop's SHAPE, which is the part
 * that must not drift: four timestamps, the same seven bubbles in the same
 * order, three timed steps and two contrast cells.
 */

vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');

const HTML = Object.fromEntries(
  await Promise.all(
    routing.locales.map(async (locale) => [
      locale,
      renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale }) })),
    ]),
  ),
) as Record<(typeof routing.locales)[number], string>;

/** The transcript section only — the hero carries its own three bubbles now, so
 * a page-wide scan would count two conversations as one. `v4-thread-cap` is the
 * caption only the transcript wears. */
function transcript(html: string): string {
  return html.match(/<p class="v4-thread-cap"[\s\S]*?<\/section>/)?.[0] ?? '';
}

/** The hero's own three-bubble exchange, the other conversation on the page. */
function heroExchange(html: string): string {
  return html.match(/<div class="v4-hero-thread[\s\S]*?<\/div>/)?.[0] ?? '';
}

function landingBundle(locale: string): Record<string, unknown> {
  return (
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
    ) as { Landing: Record<string, unknown> }
  ).Landing;
}

/** The hero H1 is `max-width: 15ch`, and a ch is the width of the display face's
 * zero: 0.606em in Fraunces (en/fr) and 0.46em in the serif the ≥1024px rule hands
 * zh, so the column is 9.09em wide for en/fr and 6.9em for zh (computed max-width
 * ÷ font-size, Chromium, 1440×900). A CJK glyph advances exactly 1em in every CJK
 * face, so a zh line is its glyph count plus the word space — one glyph too many
 * wraps the compound mid-word and pushes the hero CTA under the 900px fold, which
 * no static-markup test can see. Latin is counted at 0.42em, generous against the
 * 0.32em average measured for Fraunces at 450, so the estimate errs toward failing. */
const H1_COLUMN_EM: Record<(typeof routing.locales)[number], number> = {
  en: 9.09,
  fr: 9.09,
  zh: 6.9,
};

/** The town Hale's hero reply names back, per locale — zh transliterates it. */
const HERO_TOWN: Record<(typeof routing.locales)[number], string> = {
  en: 'Stouffville',
  fr: 'Stouffville',
  zh: '斯托夫维尔',
};

function landingString(locale: string, key: string): string {
  const value = landingBundle(locale)[key];
  if (typeof value !== 'string') throw new Error(`${locale}.Landing.${key} is not a string`);
  return value;
}

/** Mirrors `accentSeparator` in the landing: Latin takes a word space, zh sets solid. */
function accentSeparator(locale: string): string {
  return locale === 'zh' ? '' : ' ';
}

function advanceEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u.test(ch)) em += 1;
    else if (ch === ' ') em += 0.25;
    else em += 0.42;
  }
  return em;
}

describe('the registration loop renders in every locale', () => {
  it.each(routing.locales)('%s runs four legs and seven bubbles, in order', (locale) => {
    const html = transcript(HTML[locale]);
    expect(html, 'the transcript must render').toContain('v4-bubble');
    expect([...html.matchAll(/class="v4-thread-time"/g)]).toHaveLength(4);
    expect([...html.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(5);
    expect([...html.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(2);
    // The out-bubbles are the parent's two turns: the yes that unlocks the
    // quiet-hours-exempt legs, then the outcome. Both must land AFTER the leg
    // that asks for them, in every language.
    const rows = [...html.matchAll(/class="v4-(thread-time|bubble v4-bubble-(?:in|out))"/g)].map(
      (m) => (m[1] === 'thread-time' ? 'time' : m[0].endsWith('out"') ? 'out' : 'in'),
    );
    expect(rows).toEqual([
      'time',
      'in',
      'out',
      'time',
      'in',
      'time',
      'in',
      'time',
      'in',
      'out',
      'in',
    ]);
  });

  it.each(routing.locales)('%s carries the municipal link Hale really sends', (locale) => {
    // Not translated: it is a URL. A locale that "translates" it points a parent
    // at a page that does not exist.
    expect(HTML[locale]).toContain('haltonhills.ca/Play/Recreation/Programs');
  });

  it.each(routing.locales)('%s marks all three steps and both contrast cells', (locale) => {
    expect([...HTML[locale].matchAll(/class="v4-when"/g)]).toHaveLength(3);
    expect([...HTML[locale].matchAll(/class="v4-contrast[^"]*"/g)]).toHaveLength(1);
  });

  it.each(routing.locales)(
    '%s states the watch in both contrast cells and one coverage line',
    (locale) => {
      const html = HTML[locale];
      const text = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const cells = landingBundle(locale).contrast as Array<{ title: string; body: string }>;
      expect(cells).toHaveLength(2);
      for (const cell of cells) {
        expect(text).toContain(cell.body);
      }
      const coverage = landingString(locale, 'coverageLine').replace(
        '{count}',
        String(MUNICIPALITY_COUNT),
      );
      const lede = landingString(locale, 'watchLede').replace(
        '{count}',
        String(MUNICIPALITY_COUNT),
      );
      const noun = { en: 'municipalities', fr: 'municipalités', zh: '市镇' }[locale];
      expect(text).toContain(coverage);
      expect(text).toContain(lede);
      expect(coverage).toContain(noun);
      expect(lede).toContain(noun);
      expect(coverage).not.toMatch(/cities|villes|城市/);
      expect(html).not.toContain('{count}');
      // The sell-out pitch and the one-YES execute line stay off every locale.
      for (const banned of [
        '7:02',
        '7 h 02',
        'reply YES once',
        'OUI une fois',
        '回复一次 YES',
        '$54',
        '54 $',
      ]) {
        expect(text, banned).not.toContain(banned);
      }
      expect([...html.matchAll(/class="v4-coverage/g)]).toHaveLength(1);
      expect(html).not.toContain('class="v4-pill');
      const line = html.match(/<p class="v4-coverage[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? '';
      expect(line).toBe(coverage);
      expect(line).not.toContain('<a');
      expect(line).not.toContain('/text');
    },
  );

  it.each(routing.locales)('%s has no homepage question chips', (locale) => {
    const html = HTML[locale];
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('class="v4-chips"');
    expect(html).not.toContain('hero_chip');
  });

  it.each(routing.locales)(
    '%s opens on the hero exchange — the ask and the find, before the transcript',
    (locale) => {
      // A believable request and Hale's find, above the fold, in every language.
      // It is the same bubble styling, in a hero-scoped wrapper, so the transcript
      // scans above stay about the transcript. No third bubble: the watch YES is gone.
      const hero =
        HTML[locale].match(/<section class="v4-hero v4-hero-top"[\s\S]*?<\/section>/)?.[0] ?? '';
      expect(hero, 'the hero must render').toContain('v4-hero-thread');
      expect([...hero.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(1);
      expect([...hero.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(1);
      expect(hero).not.toContain('v4-thread-time');
      // The hero exchange must land before the transcript's own label.
      expect(HTML[locale].indexOf('v4-hero-thread')).toBeLessThan(
        HTML[locale].indexOf('v4-thread-cap'),
      );
    },
  );

  it.each(routing.locales)('%s answers about the town the hero asked about', (locale) => {
    // Every other assertion over the hero is structural, so a translator could
    // leave one language answering about a town — and a cycle — the en copy has
    // moved off, and the suite would stay green. Reverting fr's reply to the
    // closed Halton Hills sentence is exactly that, and this is what sees it.
    const reply =
      /<p class="v4-bubble v4-bubble-in">([\s\S]*?)<\/p>/.exec(heroExchange(HTML[locale]))?.[1] ??
      '';
    expect(reply, 'the hero reply must render').not.toBe('');
    expect(reply, locale).toContain(HERO_TOWN[locale]);
  });

  it('carries every Landing key in all three bundles — no locale silently renders a key name', () => {
    const keys = (locale: string) => Object.keys(landingBundle(locale)).sort();
    const en = keys('en');
    expect(en.length).toBeGreaterThan(30);
    for (const locale of routing.locales) expect(keys(locale), locale).toEqual(en);
  });

  it.each(routing.locales)(
    '%s fits each hero H1 line inside the 15ch column at the desktop ceiling',
    (locale) => {
      // The markup forces one break: heroH1a, then heroH1b + the locale's separator + the accent.
      const lines = [
        landingString(locale, 'heroH1a'),
        `${landingString(locale, 'heroH1b')}${accentSeparator(locale)}${landingString(locale, 'heroH1Accent')}`,
      ];
      for (const line of lines) {
        expect(advanceEm(line), `${locale}: "${line}"`).toBeLessThanOrEqual(H1_COLUMN_EM[locale]);
      }
    },
  );

  it('would have caught the zh accent that wrapped mid-compound', () => {
    // The line that shipped as "之后便 安静下 / 来。" at 1440×900 and put the hero CTA under the fold.
    expect(advanceEm('之后便 安静下来。')).toBeGreaterThan(H1_COLUMN_EM.zh);
  });

  it.each(routing.locales)('%s keeps BOTH demos evergreen — no calendar date', (locale) => {
    // Run over the hero exchange as well as the transcript. A translator writing
    // the hero reply has the same temptation to print the cycle the row is drawn
    // from, and the hero is the one a first-time reader sees — scoping this to
    // the transcript left the above-the-fold copy the only ungated conversation
    // on the page. 20xx would be a cycle label; the clock times (10:04, 7:00) are
    // three digits or fewer either side of the colon and cannot match.
    for (const [name, block] of [
      ['the transcript', transcript(HTML[locale])],
      ['the hero exchange', heroExchange(HTML[locale])],
    ] as const) {
      expect(block, `${name} must render`).toContain('v4-bubble');
      expect(block, `${locale} · ${name}`).not.toMatch(/\b20\d\d\b/);
    }
  });

  it.each(routing.locales)('%s hero demos are the live find, with no watch YES', (locale) => {
    const landing = landingBundle(locale) as {
      heroThread: Array<{ dir: string; text: string }>;
      heroLoop: Array<{ rows: Array<{ dir: string; text: string }> }>;
    };
    expect(landing.heroThread.map((row) => row.dir)).toEqual(['out', 'in']);
    expect(landing.heroLoop[0]?.rows.map((row) => row.dir)).toEqual(['out', 'in']);
    const lead = {
      en: 'Here’s what’s on for your kids this year:',
      fr: 'Voici ce qu’il y a pour vos enfants cette année :',
      zh: '孩子这一年，现在有这些：',
    }[locale];
    expect(landing.heroThread[1]?.text.startsWith(lead)).toBe(true);
    expect(landing.heroLoop[0]?.rows[1]?.text.startsWith(lead)).toBe(true);
    const demo = `${landing.heroThread.map((row) => row.text).join('\n')}\n${landing.heroLoop
      .flatMap((beat) => beat.rows.map((row) => row.text))
      .join('\n')}`;
    for (const banned of [
      'YES',
      'OUI',
      'keep an eye',
      'garde un oeil',
      '回复 YES',
      '要不要我',
      'Say YES',
      'Répondez OUI',
    ]) {
      expect(demo, banned).not.toContain(banned);
    }
    expect(demo).toContain('1.');
    expect(demo).toContain('3.');
  });

  it.each(routing.locales)('%s says who is speaking, not only which side', (locale) => {
    // Direction is drawn with align-self and a fill; in dark the out-bubble's
    // navy sits on a near-identical glass ground, so a reader who cannot see the
    // alignment does not know whose turn it was. Every bubble in both
    // conversations carries an sr-only speaker, and the hero exchange opens on a
    // caption — the transcript's visible `v4-thread-cap`, said only to the reader
    // the layout does not reach, because the hero has no fold height to spend on
    // a line its sighted reader can already see.
    const html = HTML[locale];
    const bubbles = [...html.matchAll(/<p class="v4-bubble[^"]*">([\s\S]*?)<\/p>/g)].map(
      (m) => m[1] ?? '',
    );
    // Hero is two bubbles (ask, find). The transcript is still seven.
    expect(bubbles.length, 'the bubbles must render').toBe(9);
    for (const bubble of bubbles) expect(bubble).toMatch(/^<span class="sr-only">[^<]+ <\/span>/);
    expect(heroExchange(html)).toMatch(
      /^<div class="v4-hero-thread[^>]*><p class="sr-only">[^<]+</,
    );
  });
});

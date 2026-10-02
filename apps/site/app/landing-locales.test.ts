import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import { MUNICIPALITIES } from '~/lib/site/municipalities.js';
import LandingPage from './[locale]/page.js';

/**
 * The homepage copy is a per-locale bundle. A translator who drops a row, puts
 * a town back in the hero, or strips the accents off French site copy should fail here.
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

function landingBundle(locale: string): Record<string, unknown> {
  return (
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
    ) as { Landing: Record<string, unknown> }
  ).Landing;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function heroExchange(html: string): string {
  return html.match(/<div class="v4-hero-thread[\s\S]*?<\/div>/)?.[0] ?? '';
}

/** Mirrors `accentSeparator` in the landing: Latin takes a word space, zh sets solid. */
function accentSeparator(locale: string): string {
  return locale === 'zh' ? '' : ' ';
}

const H1_COLUMN_EM: Record<(typeof routing.locales)[number], number> = {
  en: 9.09,
  fr: 9.09,
  zh: 6.9,
};

function landingString(locale: string, key: string): string {
  const value = landingBundle(locale)[key];
  if (typeof value !== 'string') throw new Error(`${locale}.Landing.${key} is not a string`);
  return value;
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

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) walkStrings(inner, visit);
  }
}

describe('homepage copy in every locale', () => {
  it('carries every Landing key in all three bundles', () => {
    const keys = (locale: string) => Object.keys(landingBundle(locale)).sort();
    const en = keys('en');
    expect(en.length).toBeGreaterThan(20);
    for (const locale of routing.locales) expect(keys(locale), locale).toEqual(en);
  });

  it.each(routing.locales)('%s hero is the ask and the find, with no town', (locale) => {
    const landing = landingBundle(locale) as {
      heroThread: Array<{ dir: string; text: string }>;
    };
    expect(landing.heroThread.map((row) => row.dir)).toEqual(['out', 'in']);
    const exchange = heroExchange(HTML[locale]);
    expect(exchange, 'the phone thread must render').toContain('v4-bubble');
    expect([...exchange.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(1);
    expect([...exchange.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(1);
    expect(exchange).not.toMatch(/\b20\d\d\b/);
    const text = visibleText(exchange);
    for (const town of [...MUNICIPALITIES, 'Georgetown', '斯托夫维尔', '多伦多', '乔治敦']) {
      expect(text, `${locale} names ${town}`).not.toContain(town);
    }
  });

  it.each(routing.locales)('%s fits each hero line in the display column', (locale) => {
    const lines = [
      landingString(locale, 'heroH1a'),
      `${landingString(locale, 'heroH1b')}${accentSeparator(locale)}${landingString(locale, 'heroH1Accent')}`,
    ];
    for (const line of lines) {
      expect(advanceEm(line), `${locale}: "${line}"`).toBeLessThanOrEqual(H1_COLUMN_EM[locale]);
    }
  });

  it('would have caught a zh line that wraps mid-compound', () => {
    expect(advanceEm('之后便 安静下来。')).toBeGreaterThan(H1_COLUMN_EM.zh);
  });

  it.each(routing.locales)('%s says who is speaking in every bubble', (locale) => {
    const bubbles = [...HTML[locale].matchAll(/<p class="v4-bubble[^"]*">([\s\S]*?)<\/p>/g)].map(
      (m) => m[1] ?? '',
    );
    // The hero exchange: the ask, then the find.
    expect(bubbles).toHaveLength(2);
    for (const bubble of bubbles) expect(bubble).toMatch(/^<span class="sr-only">[^<]+ <\/span>/);
  });

  it.each(routing.locales)('%s renders the four lines, pricing, and the FAQ', (locale) => {
    const text = visibleText(HTML[locale]);
    for (const key of ['findH2', 'remindH2', 'yearH2', 'memoryH2', 'trustH2', 'faqH2']) {
      expect(text, key).toContain(landingString(locale, key));
    }
    expect(HTML[locale]).toContain('id="pricing"');
    expect([...HTML[locale].matchAll(/<details\b/g)]).toHaveLength(3);
  });

  it('writes French site copy with accents, in the vous register the rest of the site uses', () => {
    const fr = JSON.parse(
      readFileSync(fileURLToPath(new URL('../messages/fr.json', import.meta.url)), 'utf8'),
    ) as Record<string, unknown>;
    const pieces: string[] = [];
    for (const key of ['Landing', 'HomeMeta', 'Pricing', 'PricingSection', 'Jsonld']) {
      walkStrings(fr[key], (text) => pieces.push(text));
    }
    const blob = pieces.join('\n');
    for (const word of ['près', 'données', 'confidentialité', 'bientôt', 'âge', 'activités']) {
      expect(blob, word).toContain(word);
    }
    const flat = blob.toLowerCase();
    for (const ascii of ['donnees', 'bientot', 'confidentialite', 'pres de']) {
      expect(flat, ascii).not.toContain(ascii);
    }
    const landing = landingBundle('fr');
    expect(String(landing.heroH1a)).toContain('vos');
    expect(String(landing.heroTerms)).toMatch(/^Vos /);
  });

  it.each(routing.locales)('%s hero headline and subhead stay inside the word caps', (locale) => {
    const headline = `${landingString(locale, 'heroH1a')} ${landingString(locale, 'heroH1b')} ${landingString(locale, 'heroH1Accent')}`;
    const sub = landingString(locale, 'heroSub');
    if (locale === 'zh') return;
    const words = (s: string) => s.split(/[^A-Za-z0-9']+/).filter(Boolean);
    expect(words(headline).length).toBeLessThanOrEqual(8);
    expect(words(sub).length).toBeLessThanOrEqual(22);
    expect(words(sub).length).toBeGreaterThan(0);
  });
});

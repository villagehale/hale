import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import LandingPage from './[locale]/page.js';

/**
 * French and Chinese use the same redesign as English. The old v4 registration
 * loop stays in the message bundles (its keys must not drift) but it is no longer
 * what a parent sees.
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

function rd(html: string): string {
  const found = html.match(/<div class="rd">[\s\S]*$/);
  return found?.[0] ?? '';
}

function landingBundle(locale: string): Record<string, unknown> {
  return (
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
    ) as { Landing: Record<string, unknown> }
  ).Landing;
}

/** The hero H1 is `max-width: 15ch` on the retired v4 landing. The pin stays on
 * the bundle so a translator cannot lengthen a line the old layout still stores. */
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

describe('every locale renders the redesign', () => {
  it.each(routing.locales)('%s has no homepage question chips and no v4 loop', (locale) => {
    const html = HTML[locale];
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('class="v4-chips"');
    expect(html).not.toContain('hero_chip');
    expect(html).not.toContain('v4-hero-thread');
    expect(html).not.toContain('v4-thread-cap');
    expect(html).not.toContain('Stouffville');
  });

  it('opens on the approved H1 in each language', () => {
    expect(HTML.en).toContain('Your kids’ year,');
    expect(HTML.en).toContain('handled.');
    expect(HTML.en).toContain('Library playgroup');
    expect(rd(HTML.fr)).toContain('L’année de tes enfants,');
    expect(rd(HTML.fr)).toContain('sans casse-tête.');
    expect(rd(HTML.fr)).not.toContain('Your kids’ year,');
    expect(rd(HTML.zh)).toContain('孩子这一年，');
    expect(rd(HTML.zh)).toContain('交给 Hale。');
    expect(rd(HTML.zh)).not.toContain('Your kids’ year,');
    expect(rd(HTML.zh)).not.toContain('已报名');
  });

  it('uses tu inside the French redesign', () => {
    const body = rd(HTML.fr);
    // « Rendez-vous » is the playdate noun, not the vous pronoun.
    const prose = body.replace(/rendez-vous/gi, '');
    expect(prose).not.toMatch(/\bvous\b/i);
    expect(prose).not.toMatch(/\bvos\b/i);
    expect(prose).not.toMatch(/\bvotre\b/i);
    expect(body).toContain('camp');
  });

  it('keeps the FR and ZH hero and sign-up lines on the English promise', () => {
    const fr = rd(HTML.fr);
    expect(fr).toContain('aide tout le monde à s’entendre');
    expect(fr).toContain('Inscriptions faites pour toi, quand tu dis oui');
    expect(fr).toContain('Inscriptions de tous les enfants d’un coup');
    expect(fr).toContain('L’inscription à ta place viendra plus tard, et seulement si tu dis oui.');
    expect(fr).toContain('Demande comment ça s’est passé');
    expect(fr).toContain('Texte Hale');
    expect(fr).toContain('Pour toute la gang, chaque enfant, chaque personne qui aide.');
    expect(rd(HTML.en)).toContain('For the whole crew, every kid, every helper.');
    const zh = rd(HTML.zh);
    expect(zh).toContain('它帮你找活动、让大家定下来');
    expect(zh).toContain('你点头后代你报名');
    expect(zh).toContain('几个孩子一次报完');
    expect(zh).toContain('给整伙人，每个孩子，每个帮忙的人。');
    expect(zh).toContain('以后会推出代报名，前提是你先点头。');
    expect(zh).not.toContain('已报名');
  });

  it('carries every Landing key in all three bundles — no locale silently renders a key name', () => {
    const keys = (locale: string) => Object.keys(landingBundle(locale)).sort();
    const en = keys('en');
    expect(en.length).toBeGreaterThan(30);
    for (const locale of routing.locales) expect(keys(locale), locale).toEqual(en);
  });

  it.each(routing.locales)(
    '%s fits each retired-landing hero H1 line inside the 15ch column',
    (locale) => {
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
    expect(advanceEm('之后便 安静下来。')).toBeGreaterThan(H1_COLUMN_EM.zh);
  });

  it.each(routing.locales)(
    '%s hero demos in the bundle are the live find, with no watch YES',
    (locale) => {
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
    },
  );
});

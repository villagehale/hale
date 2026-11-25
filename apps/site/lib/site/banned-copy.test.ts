import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RedesignHome } from '~/components/redesign/home';
import { RedesignPricing } from '~/components/redesign/pricing';

/**
 * VIL-769: the 11-23 narrative's banned marketing lines must not appear in
 * apps/site. Cited parenting-health articles (lib/answers) are out of this
 * scan: they quote guidance and are not Hale's price or product pitch.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const priceWord = 'fr' + 'ee';

const phrases = [
  'founding ' + 'family',
  'founding ' + 'families',
  'first ' + '100',
  'small and ' + 'early',
  `always ${priceWord}`,
  `${priceWord} for every`,
  `${priceWord} stays ${priceWord}`,
  'helps you ' + 'remember',
  'helps you get ' + 'registered',
  'reminds ' + 'you',
  'remind ' + 'whoever',
  'night ' + 'before',
  'missed ' + 'sign',
  'I’ll send you each the ' + 'link',
  'AI agent you ' + 'text',
  'You ' + 'text Hale',
  'kids' + "' year",
  'kids' + '\u2019 year',
  'spot ' + 'watch',
  'year ' + 'memory',
  'calendar ' + 'invite',
  'spot ' + 'opened',
  'Gets the open ' + 'spot',
  'A seat just ' + 'opened',
  'Prend la place ' + 'libre',
  'Une place vient ' + 'd\u2019ouvrir',
  'J\u2019ai eu la ' + 'place',
  '今天拿到空出的' + '名额',
  '拿到空出来的' + '名额',
  '刚空出一个' + '名额',
  '抢到名额' + '了',
];

const priceWordPattern = new RegExp(`\\b${priceWord}\\b`, 'i');

/** The sale block must not bring the open-spot chip back. Split so this file does not contain the phrase. */
const promoSpotPhrases = [
  'Gets the open ' + 'spot',
  'Prend la place ' + 'libre',
  '拿到空出来的' + '名额',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|json|css|mjs|md|txt)$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(root).filter((path) => {
    const rel = relative(root, path);
    if (rel.startsWith(`lib${'/'}answers${'/'}`)) return false;
    // SIL OFL ships beside the self-hosted faces. The license text is not a price pitch.
    if (
      rel.endsWith('-OFL.txt') &&
      (rel.startsWith('app/fonts/') || rel.startsWith('components/promo/fonts/'))
    ) {
      return false;
    }
    return true;
  });
}

describe('banned 11-23 marketing lines', () => {
  const files = sourceFiles();

  it('scans the site tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no banned phrase and no price-word pitch', () => {
    const hits: string[] = [];
    for (const path of files) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      for (const phrase of phrases) {
        const at = text.toLowerCase().indexOf(phrase.toLowerCase());
        if (at >= 0) hits.push(`${rel}: ${phrase}`);
      }
      // Prod CSS keeps the .t-free class and comments that name that card.
      // The class token is not the marketing word.
      if (
        !rel.endsWith('.css') &&
        priceWordPattern.test(
          text.replaceAll('t-free', 't-tier').replaceAll('is-it-free', 'is-it-tier').replaceAll('is-my-co-parent-free', 'is-my-co-parent-tier'),
        )
      ) {
        hits.push(`${rel}: ${priceWord}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps the open-spot chip out of the sale block', () => {
    const promoFiles = files.filter((path) => {
      const rel = relative(root, path);
      return rel.startsWith('components/promo/') || rel === 'app/promo.css';
    });
    expect(promoFiles.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const path of promoFiles) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      for (const phrase of promoSpotPhrases) {
        if (text.toLowerCase().includes(phrase.toLowerCase())) hits.push(`${rel}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

const YEARLY_BANNED = [/\/mois/, /每月/, /au mois/, /按月/, /Bientôt disponible/, /即将推出/];

describe('fr and zh pages stay yearly-only', () => {
  const base = {
    smsNumber: '+16462352164',
    prefill: "Hey Hale, what's going on?",
    source: null,
    promo: null,
  } as const;

  it('does not render monthly prices or coming-soon on home or pricing', () => {
    const pages: string[] = [];
    for (const locale of ['fr', 'zh'] as const) {
      for (const priceSurface of ['legacy', 'list'] as const) {
        for (const currency of ['CAD', 'USD'] as const) {
          const props = { ...base, locale, priceSurface, currency };
          pages.push(renderToStaticMarkup(createElement(RedesignHome, props)));
          pages.push(renderToStaticMarkup(createElement(RedesignPricing, props)));
        }
      }
    }
    expect(pages.length).toBe(16);
    const hits: string[] = [];
    for (const html of pages) {
      for (const pattern of YEARLY_BANNED) {
        if (pattern.test(html)) hits.push(html.match(pattern)?.[0] ?? pattern.source);
      }
    }
    expect(hits).toEqual([]);
  });
});

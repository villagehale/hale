import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '~/i18n/routing';
import LandingPage from '../../app/[locale]/page.js';
import PricingPage from '../../app/[locale]/pricing/page.js';
import { PILLARS } from '~/lib/site/narrative';

/**
 * The hero loop is Prod's four icons with the four pillar names.
 * The first price card is Text at $0/mo, and the price-word is not on it.
 */

const PILLAR_TITLE: Record<Locale, Record<(typeof PILLARS)[number]['title'], string>> = {
  en: {
    'Knows your family': 'Knows your family',
    'Finds what fits': 'Finds what fits',
    'Gets the spot': 'Gets the spot',
    'Runs the group chat': 'Runs the group chat',
  },
  fr: {
    'Knows your family': 'Connaît ta famille',
    'Finds what fits': 'Trouve ce qui convient',
    'Gets the spot': 'Prend la place',
    'Runs the group chat': 'Tient le groupe',
  },
  zh: {
    'Knows your family': '了解你的家庭',
    'Finds what fits': '找到合适的',
    'Gets the spot': '拿到名额',
    'Runs the group chat': '管家长群',
  },
};

const TEXT_CARD: Record<Locale, { name: string; price: string; meta: string }> = {
  en: { name: 'Text', price: '$0/mo', meta: 'No card needed' },
  fr: { name: 'Texto', price: '0 $/mois', meta: 'Aucune carte requise.' },
  zh: { name: '短信', price: '每月 $0', meta: '不需要银行卡。' },
};

const locales = ['en', 'fr', 'zh'] as const;

const priceWord = 'fr' + 'ee';

describe('the hero pillars and the Text card', () => {
  for (const locale of locales) {
    it(`shows the ${locale} pillars and a Text card without the price-word`, async () => {
      const params = Promise.resolve({ locale });
      const home = renderToStaticMarkup(await LandingPage({ params }));
      const pricing = renderToStaticMarkup(await PricingPage({ params }));
      const loopStart = home.indexOf('class="loop');
      const loop = home.slice(loopStart, home.indexOf('</ul>', loopStart));
      expect(PILLARS).toHaveLength(4);
      for (const pillar of PILLARS) {
        expect(loop).toContain(PILLAR_TITLE[locale][pillar.title]);
      }
      expect(loop).not.toContain('Reads your Gmail');
      expect(loop.match(/<li>/g)).toHaveLength(4);

      for (const html of [home, pricing]) {
        expect(html.match(/hs-tier t-free/g)?.length).toBe(1);
        expect(html.match(/hs-tier t-plus/g)?.length).toBe(1);
        expect(html.match(/hs-tier t-max/g)?.length).toBe(1);
        const card = html.match(/<li class="hs-tier t-free">[\s\S]*?<\/li>/)?.[0] ?? '';
        expect(card).toContain(TEXT_CARD[locale].name);
        expect(card).toContain(TEXT_CARD[locale].price);
        expect(card).toContain(TEXT_CARD[locale].meta);
        expect(card).toContain('>01<');
        expect(card.replaceAll(`t-${priceWord}`, 't-tier')).not.toMatch(
          new RegExp(`\\b${priceWord}\\b`, 'i'),
        );
        expect(html).toContain('hs-tier-num">02');
        expect(html).toContain('hs-tier-num">03');
      }
    });
  }
});

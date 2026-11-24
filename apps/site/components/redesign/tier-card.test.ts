import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '~/i18n/routing';
import LandingPage from '../../app/[locale]/page.js';
import PricingPage from '../../app/[locale]/pricing/page.js';
import { PILLARS } from '~/lib/site/narrative';

/**
 * The hero carries the five pillars. There is no $0 plan card.
 */

const PILLAR_TITLE: Record<Locale, Record<(typeof PILLARS)[number]['title'], string>> = {
  en: {
    'Knows your family': 'Knows your family',
    'Finds what fits': 'Finds what fits',
    'Gets the spot': 'Gets the spot',
    'Runs the group chat': 'Runs the group chat',
    'Reads your Gmail and calendar': 'Reads your Gmail and calendar',
  },
  fr: {
    'Knows your family': 'Connaît ta famille',
    'Finds what fits': 'Trouve ce qui convient',
    'Gets the spot': 'Prend la place',
    'Runs the group chat': 'Tient le groupe',
    'Reads your Gmail and calendar': 'Lit ton Gmail et ton calendrier',
  },
  zh: {
    'Knows your family': '了解你的家庭',
    'Finds what fits': '找到合适的',
    'Gets the spot': '拿到名额',
    'Runs the group chat': '管家长群',
    'Reads your Gmail and calendar': '读你的 Gmail 和日历',
  },
};

const GMAIL_SUB: Record<Locale, string> = {
  en: 'Knows your family’s week',
  fr: 'Connaît la semaine de ta famille',
  zh: '知道你家这一周',
};

const locales = ['en', 'fr', 'zh'] as const;

describe('the hero pillars, with no $0 plan card', () => {
  for (const locale of locales) {
    it(`shows the ${locale} pillars and no zero-price card`, async () => {
      const params = Promise.resolve({ locale });
      const home = renderToStaticMarkup(await LandingPage({ params }));
      const pricing = renderToStaticMarkup(await PricingPage({ params }));
      for (const html of [home, pricing]) {
        expect(html).not.toContain('t-text');
        expect(html).not.toContain('$0');
        expect(html.match(/hs-tier t-plus/g)?.length).toBe(1);
        expect(html.match(/hs-tier t-max/g)?.length).toBe(1);
      }
      const loopStart = home.indexOf('class="loop');
      const loop = home.slice(loopStart, home.indexOf('</ul>', loopStart));
      for (const pillar of PILLARS) {
        expect(loop).toContain(PILLAR_TITLE[locale][pillar.title]);
      }
      expect(loop).toContain(GMAIL_SUB[locale]);
    });
  }
});

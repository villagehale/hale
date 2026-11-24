import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '~/i18n/routing';
import LandingPage from '../../app/[locale]/page.js';
import PricingPage from '../../app/[locale]/pricing/page.js';
import { PILLARS } from '~/lib/site/narrative';

/**
 * The first card carries the five pillars. The empty-weekend nudge is gone.
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

const NUDGE = 'A nudge when a weekend’s empty';

function tierCard(html: string, tier: 't-text' | 't-plus' | 't-max'): string {
  const start = html.indexOf(`hs-tier ${tier}`);
  expect(start, tier).toBeGreaterThanOrEqual(0);
  const rest = html.slice(start);
  const next = rest.slice(1).search(/hs-tier t-/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const locales = ['en', 'fr', 'zh'] as const;

describe('the first card is the five pillars', () => {
  for (const locale of locales) {
    it(`puts the ${locale} pillars on the first card of / and /pricing`, async () => {
      const params = Promise.resolve({ locale });
      const pages = [await LandingPage({ params }), await PricingPage({ params })];
      for (const page of pages) {
        const html = renderToStaticMarkup(page);
        const first = tierCard(html, 't-text');
        const plus = tierCard(html, 't-plus');
        expect(html).not.toContain(NUDGE);
        expect(first.match(/<li><svg/g)).toHaveLength(5);
        expect(plus.match(/<li><svg/g)).toHaveLength(3);
        for (const pillar of PILLARS) {
          expect(first).toContain(PILLAR_TITLE[locale][pillar.title]);
        }
      }
    });
  }
});

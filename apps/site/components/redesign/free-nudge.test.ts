import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '~/i18n/routing';
import LandingPage from '../../app/[locale]/page.js';
import PricingPage from '../../app/[locale]/pricing/page.js';

/**
 * Barton: the empty-weekend nudge is a Free feature. Both the homepage and
 * /pricing render the same three cards, so the translated line has to sit in
 * the Free card and nowhere on Plus or Max.
 */
const NUDGE: Record<Locale, string> = {
  en: 'A nudge when a weekend’s empty',
  fr: 'Un petit coup de pouce quand la fin de semaine est vide',
  zh: '周末空着的时候提你一句',
};

function tierCard(html: string, tier: 't-free' | 't-plus' | 't-max'): string {
  const start = html.indexOf(`hs-tier ${tier}`);
  expect(start, tier).toBeGreaterThanOrEqual(0);
  const rest = html.slice(start);
  const next = rest.slice(1).search(/hs-tier t-/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const locales = ['en', 'fr', 'zh'] as const;

describe('the empty-weekend nudge is Free', () => {
  for (const locale of locales) {
    it(`puts the ${locale} line on the Free card of / and /pricing`, async () => {
      const params = Promise.resolve({ locale });
      const pages = [await LandingPage({ params }), await PricingPage({ params })];
      for (const page of pages) {
        const html = renderToStaticMarkup(page);
        const free = tierCard(html, 't-free');
        const plus = tierCard(html, 't-plus');
        const max = tierCard(html, 't-max');
        expect(free).toContain(NUDGE[locale]);
        expect(plus).not.toContain(NUDGE[locale]);
        expect(max).not.toContain(NUDGE[locale]);
        // The tier itself is an <li>; the bullets are the check rows.
        expect(free.match(/<li><svg/g)).toHaveLength(5);
        expect(plus.match(/<li><svg/g)).toHaveLength(3);
        expect(html.slice(html.indexOf('hs-tier t-max'))).not.toContain(NUDGE[locale]);
      }
    });
  }

  it('does not sell the nudge as a Plus difference', async () => {
    const en = renderToStaticMarkup(
      await PricingPage({ params: Promise.resolve({ locale: 'en' }) }),
    );
    const fr = renderToStaticMarkup(
      await PricingPage({ params: Promise.resolve({ locale: 'fr' }) }),
    );
    const zh = renderToStaticMarkup(
      await PricingPage({ params: Promise.resolve({ locale: 'zh' }) }),
    );
    expect(en).toContain(
      'Plus is more done for you, all year: year memory, and sign-ups when you say yes.',
    );
    expect(en).not.toContain('a nudge when a weekend');
    expect(fr).not.toContain('un rappel quand la fin de semaine est vide');
    expect(zh).not.toContain('周末空着时提你一句');
  });
});

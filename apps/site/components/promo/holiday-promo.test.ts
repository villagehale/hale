import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RedesignHome } from '~/components/redesign/home';
import { RedesignPricing } from '~/components/redesign/pricing';
import { FOUNDING_REFUND_LINE, type PromoPhase, buildHolidayPromo } from '~/lib/promo/holiday';
import { pricingCheckoutTarget } from './founding-checkout-link';
import {
  PromoBanner,
  PromoFaqItems,
  PromoSection,
  PromoStickyCta,
  foundingAfterLine,
} from './holiday-promo';

/**
 * Barton's promo copy rules, checked on the rendered pages (both phases, both
 * countries, home and pricing):
 *  - the sale name leads; the headline features the Max sale price, with the
 *    regular Max price struck beside it (Barton, Nov 16 1:07 PM ET);
 *  - Plus and Max each show regular → sale, struck; the Text card stays $0/mo;
 *  - CA: Plus $59/yr (regular $159), Max $99/yr (regular $329);
 *    US: Plus $39/yr (regular $119), Max $79/yr (regular $259);
 *  - plain "$", never CAD / USD / C$ / US$ beside a price;
 *  - yearly only: no monthly option, no trial wording;
 *  - no was / save / % off wording; registration stays soft; no camp-finding,
 *    referral or gift offer.
 */

vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const CASES: { phase: PromoPhase; currency: 'CAD' | 'USD' }[] = [
  { phase: 'black_friday', currency: 'CAD' },
  { phase: 'black_friday', currency: 'USD' },
  { phase: 'holiday', currency: 'CAD' },
  { phase: 'holiday', currency: 'USD' },
];

const PRICES = {
  CAD: { plus: ['$159/yr', '$59/yr'], max: ['$329/yr', '$99/yr'] },
  USD: { plus: ['$119/yr', '$39/yr'], max: ['$259/yr', '$79/yr'] },
} as const;

const door = { locale: 'en' as const, smsNumber: '+16475551234', prefill: 'Hi Hale' };

const card = (html: string, tier: 'plus' | 'max') =>
  html.match(
    new RegExp(`<li class="hs-tier t-${tier}">[\\s\\S]*?(?=<li class="hs-tier |</ol>)`),
  )?.[0] ?? '';

for (const { phase, currency } of CASES) {
  const promo = buildHolidayPromo(phase, currency);
  const want = PRICES[currency];
  const other = PRICES[currency === 'USD' ? 'CAD' : 'USD'];
  const pages = {
    home: renderToStaticMarkup(createElement(RedesignHome, { ...door, promo })),
    pricing: renderToStaticMarkup(createElement(RedesignPricing, { ...door, promo })),
  };
  for (const [name, html] of Object.entries(pages)) {
    describe(`${name} · ${phase} · ${currency}`, () => {
      const body = text(html);
      const offer = html.match(/id="founding"[\s\S]*?<\/section>/)?.[0] ?? '';

      it('leads with the sale name and features the Max sale price', () => {
        expect(body).toContain('Holiday Sale');
        expect(body).not.toMatch(/Cyber Monday|Black Friday|网络星期一|黑色星期五/);
        expect(html).toContain('id="founding"');
        const sale = want.max[1].replace('$', '').replace('/yr', '');
        expect(offer).toMatch(/class="promo-offer-tier"[^>]*>Max</);
        expect(offer).toMatch(new RegExp(`class="promo-price-num"[^>]*>${sale}<`));
        expect(offer).toContain(`<s class="promo-price-regular">${want.max[0]}</s>`);
        expect(offer).toContain(`<s class="promo-price-regular">${want.plus[0]}</s>`);
        expect(text(offer)).toContain(`Plus ${want.plus[0]} ${want.plus[1]}`);
      });

      it('shows only this country’s numbers, with a plain "$" and no currency code', () => {
        const priced = body;
        expect(priced).not.toMatch(/C\$|US\$/);
        expect(priced).not.toMatch(/\$\d[\d.]*(\/(yr|mo))? ?(CAD|USD)\b/);
        expect(priced).not.toMatch(/\b(CAD|USD)\b/);
        for (const label of [...other.plus, ...other.max]) {
          if (![...want.plus, ...want.max].includes(label as never)) {
            expect(priced).not.toContain(label);
          }
        }
      });

      it('puts the regular price struck next to each paid sale price on pricing', () => {
        if (name !== 'pricing') {
          expect(html).not.toMatch(/promo-tier-price/);
          return;
        }
        for (const tier of ['plus', 'max'] as const) {
          const c = card(html, tier);
          const [regular, sale] = want[tier];
          expect(c).toContain(`<s class="promo-tier-regular">${regular}</s>`);
          expect(c).toContain(`<span class="promo-tier-sale">${sale}</span>`);
          expect(c).toContain(FOUNDING_REFUND_LINE);
          expect(text(c)).toContain(`Lock in ${sale}`);
          expect(c).toContain(`href="/api/checkout?tier=${tier}"`);
          expect(c).not.toContain('/settings/founding');
          expect(c).not.toContain('plan=');
          expect(c).not.toContain('villagehale.com/founding');
          expect(c).not.toContain('Coming soon');
          expect(c).not.toMatch(/\/mo\b/);
        }
        expect(body).toContain(`Max for ${want.max[1]}`);
      });

      it('answers after Dec 31 neutrally in the FAQ', () => {
        expect(body).not.toMatch(/Plus is \$1\d\d/);
        const faq = text(renderToStaticMarkup(createElement(PromoFaqItems, { promo })));
        expect(faq).toContain(foundingAfterLine(promo));
        expect(foundingAfterLine(promo)).toBe(
          `Families who join by Dec 31 keep ${want.max[1]} for Max or ${want.plus[1]} for Plus for as long as they’re members. Families who join after that pay the regular price.`,
        );
      });

      it('leads with the sale once and locks the price', () => {
        expect(body).not.toContain(`Our biggest ${'sale'} of the year`);
        expect(body).not.toMatch(/\bbiggest\b/i);
        expect(body).not.toMatch(/lowest price of the year/i);
        expect(body).toContain(
          'Your price for the rest of the year, locked in for as long as you’re a member. Join by Dec 31. Refund anytime.',
        );
        expect(body).toContain(
          'Billed once a year. Sale prices are for families who join by Dec 31, 2026.',
        );
        expect(body).toContain('If you cancel, the sale price ends with the membership.');
        expect(body).not.toMatch(/founding/i);
      });

      it('never uses was / save / % off wording', () => {
        expect(body).not.toMatch(/\bwas\s+(C\$|US\$|\$)/i);
        expect(body).not.toMatch(/\bsave\b|\bsaving|% ?off|percent off|half price/i);
        expect(body.toLowerCase()).not.toContain('months ' + 'fr' + 'ee');
      });

      it('keeps registration soft and makes no camp, referral or gift claim in the promo', () => {
        const promoOnly = text(
          renderToStaticMarkup(
            createElement('div', null, [
              createElement(PromoBanner, { key: 'b', promo }),
              createElement(PromoSection, { key: 's', promo, ...door, mode: 'chooser' }),
              createElement(PromoFaqItems, { key: 'f', promo }),
              createElement(PromoStickyCta, { key: 'k', promo, ...door, mode: 'chooser' }),
            ]),
          ),
        );
        expect(promoOnly).toContain('Starting Dec 1, signs them up with your ok.');
        expect(promoOnly).not.toMatch(/\bcamps?\b/i);
        expect(body).not.toMatch(/signs your kid up|sign-ups done for you/i);
        expect(body).not.toMatch(/referr|refer a|gift a year|gift-a-year/i);
        expect(body.toLowerCase()).not.toContain('nothing to pay');
        expect(body.toLowerCase()).not.toMatch(new RegExp('join(s)? ' + 'fr' + 'ee'));
      });

      it('promises refunds anytime and the lifetime lock, with no trial wording', () => {
        expect(body).toMatch(/Refund anytime/);
        expect(body).toContain(FOUNDING_REFUND_LINE);
        expect(body).toMatch(/locked in for as long as you’re a member/);
        expect(body).not.toMatch(/try it for a month|try a month|\btrial\b|first month/i);
        expect(body.toLowerCase()).not.toContain('fr' + 'ee' + ' trial');
      });

      it('places the refund line right under the sale prices, and shows no paid monthly option', () => {
        expect(offer).toMatch(
          new RegExp(
            `class="promo-offer-plus"[\\s\\S]*?class="promo-price-note"[^>]*>${FOUNDING_REFUND_LINE}`,
          ),
        );
        expect(body).not.toMatch(/\$14\/mo|\$15\/mo|\$19\/mo|\$29\/mo|\$39\/mo/);
        expect(body).not.toMatch(/by the year or the month/i);
      });

      it('offers Stripe Checkout from the sale buttons and a mobile sticky CTA', () => {
        expect(html).toContain('data-cta="promo_cta_click"');
        expect(html).toContain('href="/api/checkout?tier=max"');
        if (name === 'pricing') expect(html).toContain('href="/api/checkout?tier=plus"');
        expect(html).not.toContain('/settings/founding');
        expect(html).not.toContain('plan=');
        expect(html).not.toContain('villagehale.com/founding');
        expect(html).toContain('promo-sticky');
      });
    });
  }
}

describe('promo lock-in door', () => {
  it('opens Stripe Checkout for the tier and keeps a click id off the plan query', () => {
    expect(pricingCheckoutTarget('plus')).toBe('/api/checkout?tier=plus');
    expect(pricingCheckoutTarget('max', 'utm_source=meta&fbclid=abc')).toBe(
      '/api/checkout?tier=max&utm_source=meta&fbclid=abc',
    );
    expect(pricingCheckoutTarget('plus', 'gclid=1')).not.toContain('plan=');
    expect(pricingCheckoutTarget('max', 'gclid=1')).not.toContain('/settings/founding');
  });

  it('uses that checkout on home and pricing when a promo is passed, in en, fr, and zh', () => {
    const promo = buildHolidayPromo('black_friday', 'CAD');
    for (const locale of ['en', 'fr', 'zh'] as const) {
      for (const Page of [RedesignHome, RedesignPricing]) {
        const html = renderToStaticMarkup(createElement(Page, { ...door, locale, promo }));
        expect(html).toContain('href="/api/checkout?tier=max"');
        if (Page === RedesignPricing) expect(html).toContain('href="/api/checkout?tier=plus"');
        expect(html).not.toContain('villagehale.com/founding');
        expect(html).not.toContain('/settings/founding');
      }
    }
  });
});

describe('promo off', () => {
  it('leaves the regular page untouched', () => {
    const html = renderToStaticMarkup(createElement(RedesignHome, { ...door }));
    expect(html).not.toContain('id="founding"');
    expect(html).not.toContain('promo-bar');
    expect(text(html)).toContain('Start with a text.');
    expect(text(html)).not.toContain('Founding ' + 'famil' + 'ies join ' + 'fr' + 'ee.');
  });

  it('leaves the pricing Plus card on one plain price, with no strikethrough', () => {
    const html = renderToStaticMarkup(createElement(RedesignPricing, { ...door }));
    const card = html.match(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/)?.[0] ?? '';
    expect(card).toContain('$19/mo');
    expect(card).toContain('or $159/yr');
    expect(card).not.toMatch(/\b(CAD|USD)\b/);
    expect(card).not.toContain('$14/mo');
    expect(card).not.toMatch(/<(s|del|strike)[\s>]|promo-tier-regular|line-through/i);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RedesignHome } from '~/components/redesign/home';
import { RedesignPricing } from '~/components/redesign/pricing';
import { type PromoPhase, buildHolidayPromo, FOUNDING_REFUND_LINE } from '~/lib/promo/holiday';
import { PromoBanner, PromoFaqItems, PromoSection, PromoStickyCta } from './holiday-promo';

/**
 * Barton's promo copy rules, checked on the rendered pages (both phases, both
 * currencies, home and pricing): the sale name leads; nothing that reads as a
 * markdown sits beside "Sale"; no after-Dec-31 or regular price beside the
 * sale (the FAQ answers it neutrally); registration stays soft; no camp-finding, referral or gift offer.
 * Exception (Barton, Nov 16): the pricing-page Plus card shows the regular
 * annual price struck through next to the founding price. Banner, offer,
 * sticky bar and ads stay without strikethrough or a regular price.
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

const door = { locale: 'en' as const, smsNumber: '+16475551234', prefill: 'Hi Hale' };

for (const { phase, currency } of CASES) {
  const promo = buildHolidayPromo(phase, currency);
  const pages = {
    home: renderToStaticMarkup(createElement(RedesignHome, { ...door, promo })),
    pricing: renderToStaticMarkup(createElement(RedesignPricing, { ...door, promo })),
  };
  for (const [name, html] of Object.entries(pages)) {
    describe(`${name} · ${phase} · ${currency}`, () => {
      const body = text(html);

      it('leads with the sale name and the geo price', () => {
        expect(body).toContain(phase === 'black_friday' ? 'Black Friday Sale' : 'Holiday Sale');
        expect(body).not.toContain(phase === 'black_friday' ? 'Holiday Sale' : 'Black Friday Sale');
        expect(html).toContain('id="founding"');
        expect(body).toContain(currency === 'USD' ? '$59/yr USD' : '$79/yr CAD');
        expect(body).not.toContain(currency === 'USD' ? '$79' : '$59');
      });

      it('shows a plain "$" with a quiet currency code, never a C$ / US$ prefix', () => {
        expect(body).not.toMatch(/C\$|US\$/);
        // the big numeral carries its code beside it
        expect(html).toMatch(new RegExp(`class="promo-price-code"[^>]*>${currency}<`));
        // no price in the other country's currency
        const other = currency === 'USD' ? 'CAD' : 'USD';
        expect(body).not.toMatch(new RegExp(`\\$\\d[\\d.]*(/(yr|mo))? ${other}`));
      });

      it('keeps any after-Dec-31 or regular price off the sale surfaces', () => {
        // Barton, Nov 16: no "Plus is $159/yr CAD after Dec 31" line on any surface.
        // The pricing Plus card may show $159 / $119 struck through; that is
        // asserted separately. Sale surfaces (banner, offer, sticky, FAQ) do not.
        expect(body).not.toMatch(/Plus is \$?C?\$?159/);
        const promoOnly = text(
          renderToStaticMarkup(
            createElement('div', null, [
              createElement(PromoBanner, { key: 'b', promo }),
              createElement(PromoSection, { key: 's', promo, ...door, mode: 'chooser' }),
              createElement(PromoStickyCta, { key: 'k', promo, ...door, mode: 'chooser' }),
            ]),
          ),
        );
        expect(promoOnly).not.toMatch(/\$159|\$14\/mo|\$119/);
        expect(promoOnly).not.toMatch(/after Dec 31/i);
        // The FAQ answers it as a neutral fact, with no number.
        const faq = text(renderToStaticMarkup(createElement(PromoFaqItems, { promo })));
        expect(faq).toContain(
          `Founding families who join by Dec 31 keep ${promo.price} for as long as they’re members. Families who join after that pay the regular Plus price.`,
        );
        expect(faq).not.toMatch(/\$159|\$119|\$14\b/);
      });

      it('never pairs the sale with was / save / % off / strikethrough', () => {
        // The pricing Plus card is the one allowed strikethrough; everything
        // else, including the rest of the pricing page, stays clean.
        const saleHtml =
          name === 'pricing' ? html.replace(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/, '') : html;
        expect(saleHtml).not.toMatch(/<(s|del|strike)[\s>]/i);
        expect(saleHtml).not.toMatch(/line-through/i);
        expect(body).not.toMatch(/\bwas\s+(C\$|US\$|\$)/i);
        expect(body).not.toMatch(/\bsave\b|\bsaving|% ?off|percent off|months free|half price/i);
      });

      it('strikes the regular annual price next to founding on the pricing Plus card only', () => {
        if (name !== 'pricing') {
          expect(html).not.toMatch(/promo-plus-list|promo-plus-founding/);
          return;
        }
        const card = html.match(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/)?.[0] ?? '';
        const list = currency === 'USD' ? '$119/yr USD' : '$159/yr CAD';
        const founding = currency === 'USD' ? '$59/yr USD' : '$79/yr CAD';
        expect(card).toContain(`<s class="promo-plus-list">${list}</s>`);
        expect(card).toContain(`<span class="promo-plus-founding">${founding}</span>`);
        expect(text(card)).toContain(list);
        expect(text(card)).toContain(founding);
        // Monthly list prices are no longer the Plus headline during the promo.
        expect(card).not.toMatch(/\$14\/mo|\$19\/mo/);
        expect(card).toContain(FOUNDING_REFUND_LINE);
        const rest = text(html.replace(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/, ''));
        expect(rest).not.toMatch(/\$159|\$119/);
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
        expect(promoOnly).toContain('helps you get registered');
        expect(promoOnly).not.toMatch(/\bcamps?\b/i);
        expect(body).not.toMatch(/signs your kid up|sign-ups done for you/i);
        expect(body).not.toMatch(/referr|refer a|gift a year|gift-a-year/i);
        expect(body).not.toMatch(/join(s)? free|nothing to pay/i);
      });

      it('promises refunds anytime and the lifetime lock', () => {
        expect(body).toMatch(/Refund anytime/);
        expect(body).toContain(FOUNDING_REFUND_LINE);
        expect(body).toMatch(/locked in for as long as you’re a member/);
        expect(body).not.toMatch(/try it for a month|try a month|free trial|\btrial\b|first month/i);
      });

      it('places the refund line next to the founding price, and shows no paid monthly option', () => {
        const offer = html.match(/id="founding"[\s\S]*?<\/section>/)?.[0] ?? '';
        expect(offer).toMatch(
          new RegExp(`class="promo-price"[\\s\\S]*?class="promo-price-note"[^>]*>${FOUNDING_REFUND_LINE}`),
        );
        if (name === 'pricing') {
          const plus = html.match(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/)?.[0] ?? '';
          const max = html.match(/<li class="hs-tier t-max">[\s\S]*?<\/li>/)?.[0] ?? '';
          expect(plus).toContain(`class="promo-plus-founding"`);
          expect(plus).toContain(FOUNDING_REFUND_LINE);
          expect(max).toContain('Coming soon');
          expect(max).not.toMatch(/\/mo|\$29|\$39|\$259|\$329/);
        }
        // Free may still say $0/mo; paid monthly plans are closed during the promo.
        expect(body).not.toMatch(/\$14\/mo|\$15\/mo|\$19\/mo|\$29\/mo|\$39\/mo/);
        expect(body).not.toMatch(/by the year or the month/i);
      });

      it('offers the founding checkout door and a mobile sticky CTA', () => {
        expect(html).toContain('data-cta="promo_cta_click"');
        expect(html).toContain('https://app.villagehale.com/settings/founding');
        expect(html).toContain('promo-sticky');
      });
    });
  }
}

describe('promo off', () => {
  it('leaves the regular page untouched', () => {
    const html = renderToStaticMarkup(createElement(RedesignHome, { ...door }));
    expect(html).not.toContain('id="founding"');
    expect(html).not.toContain('promo-bar');
    expect(text(html)).toContain('Founding families join free.');
  });

  it('leaves the pricing Plus card unchanged, with no strikethrough', () => {
    const html = renderToStaticMarkup(createElement(RedesignPricing, { ...door }));
    const card = html.match(/<li class="hs-tier t-plus">[\s\S]*?<\/li>/)?.[0] ?? '';
    expect(card).toContain('$19 CAD/mo');
    expect(card).toContain('$15 USD/mo');
    expect(card).toContain('or $159 CAD / $129 USD a year, about three months free');
    expect(card).not.toMatch(/<(s|del|strike)[\s>]|promo-plus-list|line-through/i);
  });
});

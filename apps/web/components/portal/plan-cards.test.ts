import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FoundingPlan, ListPlan, PaidPlan, PlanOffer, PromoOfferPlan } from './plan-cards';

const here = dirname(fileURLToPath(import.meta.url));

describe('FoundingPlan', () => {
  it('promises every feature free, with no tier, price, or founding ordinal', () => {
    const html = renderToStaticMarkup(createElement(FoundingPlan));
    const source = readFileSync(join(here, 'plan-cards.tsx'), 'utf8');

    expect(html).toContain('Founding family');
    expect(html).toContain('Everything Hale does is free for you.');
    expect(html).toContain('There’s no plan to pick and nothing to pay.');
    expect(html).toContain('you’ll hear from Hale well before it does.');
    expect(html).not.toMatch(/coming soon|plus|max|tell me when|only free|\$\d/i);
    expect(source).not.toMatch(/founding_number|foundingNumber/);
    expect(html).not.toMatch(/#\s*\d/);
  });

  it('badges as Free when shown next to the founding offer', () => {
    const html = renderToStaticMarkup(createElement(FoundingPlan, { badge: 'Free' }));
    expect(html).toContain('Free');
    expect(html).not.toContain('Founding family');
  });
});

describe('promo Plan cards', () => {
  it('shows Plus and Max annual promo without a CAD/USD label, the paid subscription, and list prices', () => {
    const cadPlus = renderToStaticMarkup(
      createElement(PromoOfferPlan, { currency: 'CAD', tier: 'plus' }),
    );
    expect(cadPlus).toContain('$59/yr');
    expect(cadPlus).toContain('Plus');
    expect(cadPlus).toContain('Full refund anytime');
    expect(cadPlus).not.toContain('C$');
    expect(cadPlus).not.toMatch(/\bCAD\b/);
    expect(cadPlus).not.toContain('ask for a refund');
    const cadMax = renderToStaticMarkup(
      createElement(PromoOfferPlan, { currency: 'CAD', tier: 'family' }),
    );
    expect(cadMax).toContain('$99/yr');
    expect(cadMax).toContain('Max');
    expect(cadMax).not.toMatch(/\bCAD\b/);
    const usdPlus = renderToStaticMarkup(
      createElement(PromoOfferPlan, { currency: 'USD', tier: 'plus' }),
    );
    expect(usdPlus).toContain('$39/yr');
    expect(usdPlus).not.toMatch(/\bUSD\b/);
    expect(usdPlus).not.toContain('US$');
    const usdMax = renderToStaticMarkup(
      createElement(PromoOfferPlan, { currency: 'USD', tier: 'family' }),
    );
    expect(usdMax).toContain('$79/yr');
    expect(renderToStaticMarkup(createElement(PaidPlan, { tier: 'plus' }))).toContain(
      'Your family is on Plus.',
    );
    expect(renderToStaticMarkup(createElement(PaidPlan, { tier: 'family' }))).toContain(
      'Your family is on Max.',
    );
    const listCad = renderToStaticMarkup(createElement(ListPlan, { currency: 'CAD' }));
    expect(listCad).toContain('$19/mo');
    expect(listCad).toContain('$159/yr');
    expect(listCad).toContain('CAD');
    expect(listCad).toContain('Continue · $19/mo');
    expect(listCad).toContain('Continue · $159/yr');
    expect(listCad).not.toContain('C$');
    const listUsd = renderToStaticMarkup(createElement(ListPlan, { currency: 'USD' }));
    expect(listUsd).toContain('$14/mo');
    expect(listUsd).toContain('$119/yr');
    expect(listUsd).toContain('USD');
    expect(listUsd).not.toContain('US$');
  });
});

describe('PlanOffer', () => {
  it('during the promo window renders Free, Plus annual, and Max annual only', () => {
    const html = renderToStaticMarkup(
      createElement(PlanOffer, { currency: 'CAD', surface: 'founding' }),
    );
    expect(html).toContain('Free');
    expect(html).toContain('Plus');
    expect(html).toContain('Max');
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).toContain('Continue to checkout');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('$19');
    expect(html).not.toContain('Continue ·');
    expect(html).not.toMatch(/grey|gray/i);
    expect(html).not.toContain('disabled');
    expect(html).not.toMatch(/\bCAD\b/);
  });

  it('after the cutoff renders monthly and regular annual', () => {
    const html = renderToStaticMarkup(
      createElement(PlanOffer, { currency: 'CAD', surface: 'list' }),
    );
    expect(html).toContain('Continue · $19/mo');
    expect(html).toContain('Continue · $159/yr');
    expect(html).not.toContain('$59/yr');
    expect(html).not.toContain('$99/yr');
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FoundingPlan, ListPlan, PaidPlan, PromoOfferPlan } from './plan-cards';

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
  it('shows the founding offer, the paid subscription, and list prices', () => {
    const cad = renderToStaticMarkup(createElement(PromoOfferPlan, { currency: 'CAD' }));
    expect(cad).toContain('$79/yr');
    expect(cad).toContain('CAD');
    expect(cad).toContain('Full refund anytime');
    expect(cad).not.toContain('C$');
    expect(cad).not.toContain('ask for a refund');
    const usd = renderToStaticMarkup(createElement(PromoOfferPlan, { currency: 'USD' }));
    expect(usd).toContain('$59/yr');
    expect(usd).toContain('USD');
    expect(usd).not.toContain('US$');
    expect(renderToStaticMarkup(createElement(PaidPlan, { tier: 'plus' }))).toContain(
      'Your family is on Plus.',
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

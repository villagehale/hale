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
});

describe('promo Plan cards', () => {
  it('shows the founding offer, the paid subscription, and list prices', () => {
    expect(renderToStaticMarkup(createElement(PromoOfferPlan, { currency: 'CAD' }))).toContain(
      'C$79/yr',
    );
    expect(renderToStaticMarkup(createElement(PromoOfferPlan, { currency: 'USD' }))).toContain(
      'US$59/yr',
    );
    expect(renderToStaticMarkup(createElement(PaidPlan, { tier: 'plus' }))).toContain(
      'Your family is on Plus.',
    );
    const listCad = renderToStaticMarkup(createElement(ListPlan, { currency: 'CAD' }));
    expect(listCad).toContain('C$19/mo');
    expect(listCad).toContain('C$159/yr');
    const listUsd = renderToStaticMarkup(createElement(ListPlan, { currency: 'USD' }));
    expect(listUsd).toContain('US$14/mo');
    expect(listUsd).toContain('US$119/yr');
  });
});

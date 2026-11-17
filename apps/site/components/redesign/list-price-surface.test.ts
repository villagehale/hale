import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RedesignHome } from './home';
import { RedesignPricing } from './pricing';

const base = {
  locale: 'en' as const,
  smsNumber: '+16462352164',
  prefill: "Hey Hale, what's going on?",
  source: null,
};

describe('post-promo list prices on the marketing site', () => {
  it('replaces the free claims with the visitor’s plain list price', () => {
    const homeCad = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, priceSurface: 'list', currency: 'CAD' }),
    );
    const homeUsd = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, priceSurface: 'list', currency: 'USD' }),
    );
    const pricing = renderToStaticMarkup(
      createElement(RedesignPricing, { ...base, priceSurface: 'list', currency: 'CAD' }),
    );

    expect(homeCad).toContain('$19/mo');
    expect(homeCad).toContain('or $159/yr');
    expect(homeCad).toContain('$329/yr');
    expect(homeUsd).toContain('$14/mo');
    expect(homeUsd).toContain('or $119/yr');
    expect(homeUsd).toContain('$259/yr');
    expect(homeUsd).not.toContain('$19/mo');
    expect(homeCad).not.toMatch(/\b(CAD|USD|C\$|US\$)\b/);
    expect(homeUsd).not.toMatch(/\b(CAD|USD|C\$|US\$)\b/);
    expect(homeCad).not.toContain('Only Free is available today.');
    expect(homeCad).not.toContain('Founding families join free.');
    expect(homeCad).toContain('Plus is available today.');
    expect(pricing).toContain('$19/mo');
    expect(pricing).toContain('$329/yr');
    expect(pricing).not.toContain('Plus and Max are on the way.');
    expect(pricing).not.toMatch(/\b(CAD|USD)\b/);

    const fr = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, locale: 'fr', priceSurface: 'list', currency: 'CAD' }),
    );
    const zh = renderToStaticMarkup(
      createElement(RedesignPricing, {
        ...base,
        locale: 'zh',
        priceSurface: 'list',
        currency: 'USD',
      }),
    );
    expect(fr).toContain('19 $/mois');
    expect(fr).toContain('ou 159 $/an');
    expect(fr).not.toMatch(/\b(CAD|USD)\b|加元|美元/);
    expect(zh).toContain('每月 14 元');
    expect(zh).toContain('每年 259 元');
    expect(zh).not.toMatch(/加元|美元|\b(CAD|USD)\b/);
  });

  it('shows one location price and the paid tiers on the legacy surface', () => {
    const html = renderToStaticMarkup(createElement(RedesignHome, base));
    expect(html).toContain('Paid plans are Plus and Max.');
    expect(html).toContain('Start with a text.');
    expect(html).toContain('$19/mo');
    expect(html).toContain('$329/yr');
    expect(html).not.toContain('Founding families');
    expect(html).not.toContain('until paid plans');
    expect(html).not.toMatch(/\b(CAD|USD)\b/);
  });
});

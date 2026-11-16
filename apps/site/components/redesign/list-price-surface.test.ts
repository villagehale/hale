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
  it('replaces the free claims with CAD and USD list prices', () => {
    const homeCad = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, priceSurface: 'list', currency: 'CAD' }),
    );
    const homeUsd = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, priceSurface: 'list', currency: 'USD' }),
    );
    const pricing = renderToStaticMarkup(
      createElement(RedesignPricing, { ...base, priceSurface: 'list', currency: 'CAD' }),
    );

    expect(homeCad).toContain('C$19/mo');
    expect(homeCad).toContain('C$159/yr');
    expect(homeUsd).toContain('US$14/mo');
    expect(homeUsd).toContain('US$119/yr');
    expect(homeCad).not.toContain('Only Free is available today.');
    expect(homeCad).not.toContain('Founding families join free.');
    expect(homeCad).toContain('Plus is available today.');
    expect(pricing).toContain('C$19/mo');
    expect(pricing).not.toContain('Plus and Max are on the way.');

    for (const locale of ['fr', 'zh'] as const) {
      expect(() =>
        renderToStaticMarkup(
          createElement(RedesignHome, { ...base, locale, priceSurface: 'list', currency: 'CAD' }),
        ),
      ).not.toThrow();
      expect(() =>
        renderToStaticMarkup(
          createElement(RedesignPricing, {
            ...base,
            locale,
            priceSurface: 'list',
            currency: 'USD',
          }),
        ),
      ).not.toThrow();
    }
  });

  it('keeps the free claims on the legacy surface', () => {
    const html = renderToStaticMarkup(createElement(RedesignHome, base));
    expect(html).toContain('Only Free is available today.');
    expect(html).toContain('Founding families');
    expect(html).toContain('join free.');
    expect(html).not.toContain('C$19/mo');
  });
});

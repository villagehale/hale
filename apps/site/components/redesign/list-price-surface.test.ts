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
  it('replaces the legacy pitch with the visitor’s plain list price', () => {
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
    expect(homeCad).not.toContain('Only ' + 'Fr' + 'ee is available today.');
    expect(homeCad).not.toContain('Founding ' + 'famil' + 'ies join ' + 'fr' + 'ee.');
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
    expect(fr).toContain('159 $/an');
    expect(fr).toContain('329 $/an');
    expect(fr).toContain('Plus, à l’année.');
    expect(fr).not.toContain('19 $/mois');
    expect(fr).not.toContain('/mois');
    expect(fr).not.toContain('au mois');
    expect(fr).not.toContain('Bientôt disponible');
    expect(fr).not.toMatch(/\b(CAD|USD)\b|加元|美元/);
    expect(zh).toContain('每年 $119');
    expect(zh).toContain('每年 $259');
    expect(zh).toContain('Plus，按年。');
    expect(zh).not.toContain('每月');
    expect(zh).not.toContain('按月');
    expect(zh).not.toContain('即将推出');
    expect(zh).not.toMatch(/加元|美元|元|\b(CAD|USD)\b/);
  });

  it('shows yearly list prices on fr and zh on the legacy surface too', () => {
    const frHome = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, locale: 'fr', priceSurface: 'legacy', currency: 'CAD' }),
    );
    const frPricing = renderToStaticMarkup(
      createElement(RedesignPricing, { ...base, locale: 'fr', priceSurface: 'legacy', currency: 'CAD' }),
    );
    const zhHome = renderToStaticMarkup(
      createElement(RedesignHome, { ...base, locale: 'zh', priceSurface: 'legacy', currency: 'USD' }),
    );
    const zhPricing = renderToStaticMarkup(
      createElement(RedesignPricing, { ...base, locale: 'zh', priceSurface: 'legacy', currency: 'USD' }),
    );
    for (const html of [frHome, frPricing]) {
      expect(html).toContain('159 $/an');
      expect(html).toContain('329 $/an');
      expect(html).toContain('>$0<');
      expect(html).not.toContain('/mois');
      expect(html).not.toContain('au mois');
      expect(html).not.toContain('Bientôt disponible');
    }
    for (const html of [zhHome, zhPricing]) {
      expect(html).toContain('每年 $119');
      expect(html).toContain('每年 $259');
      expect(html).toContain('>$0<');
      expect(html).not.toContain('每月');
      expect(html).not.toContain('按月');
      expect(html).not.toContain('即将推出');
    }
  });

  it('shows one location price and the paid tiers on the legacy surface', () => {
    const html = renderToStaticMarkup(createElement(RedesignHome, base));
    expect(html).toContain('Paid plans are Plus and Max.');
    expect(html).toContain('Start with a text.');
    expect(html).toContain('$19/mo');
    expect(html).toContain('$329/yr');
    expect(html).not.toContain('Founding ' + 'famil' + 'ies');
    expect(html).not.toContain('until paid plans');
    expect(html).not.toMatch(/\b(CAD|USD)\b/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  foundingPriceLabel,
  maxListPriceLabel,
  plusListPriceLabels,
  promoPriceLabel,
} from './price-display';

describe('hale-web price labels', () => {
  it('uses a plain $ with no CAD/USD label on promo amounts', () => {
    expect(promoPriceLabel('plus', 'CAD')).toBe('$59/yr');
    expect(promoPriceLabel('plus', 'USD')).toBe('$39/yr');
    expect(promoPriceLabel('family', 'CAD')).toBe('$99/yr');
    expect(promoPriceLabel('family', 'USD')).toBe('$79/yr');
    expect(foundingPriceLabel('CAD')).toBe('$59/yr');
    expect(foundingPriceLabel('USD')).toBe('$39/yr');
    expect(plusListPriceLabels('CAD')).toEqual({ monthly: '$19/mo', annual: '$159/yr' });
    expect(plusListPriceLabels('USD')).toEqual({ monthly: '$14/mo', annual: '$119/yr' });
    expect(maxListPriceLabel('CAD')).toBe('$329/yr');
    expect(maxListPriceLabel('USD')).toBe('$259/yr');
  });
});

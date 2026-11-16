import { describe, expect, it } from 'vitest';
import { foundingPriceLabel, plusListPriceLabels } from './price-display';

describe('hale-web price labels', () => {
  it('uses a plain $ and leaves C$/US$ to the marketing site', () => {
    expect(foundingPriceLabel('CAD')).toBe('$79/yr');
    expect(foundingPriceLabel('USD')).toBe('$59/yr');
    expect(plusListPriceLabels('CAD')).toEqual({ monthly: '$19/mo', annual: '$159/yr' });
    expect(plusListPriceLabels('USD')).toEqual({ monthly: '$14/mo', annual: '$119/yr' });
  });
});

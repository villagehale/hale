import { describe, expect, it } from 'vitest';
import {
  FOUNDING_CAD_CENTS,
  FOUNDING_PROMO_METADATA,
  FOUNDING_USD_CENTS,
  PLUS_USD_ANNUAL_CENTS,
  PLUS_USD_LIST_METADATA,
  PLUS_USD_MONTHLY_CENTS,
  type StripeCatalogApi,
  type StripePriceRecord,
  type StripeProductRecord,
  ensurePromoPrices,
  formatCreatedPriceIds,
} from './create-prices.js';

function fakeApi(seed: {
  prices?: StripePriceRecord[];
  products?: StripeProductRecord[];
}): { api: StripeCatalogApi; createdPrices: StripePriceRecord[]; createdProducts: string[] } {
  const prices = [...(seed.prices ?? [])];
  const products = [...(seed.products ?? [])];
  const createdPrices: StripePriceRecord[] = [];
  const createdProducts: string[] = [];
  let n = 0;
  return {
    createdPrices,
    createdProducts,
    api: {
      async listPrices() {
        return prices;
      },
      async listProducts() {
        return products;
      },
      async createProduct(input) {
        n += 1;
        const product = { id: `prod_${n}`, name: input.name, metadata: input.metadata };
        products.push(product);
        createdProducts.push(product.id);
        return product;
      },
      async createPrice(input) {
        n += 1;
        const price: StripePriceRecord = {
          id: `price_${n}`,
          currency: input.currency,
          unitAmount: input.unitAmount,
          interval: input.interval,
          metadata: input.metadata,
          productId: input.productId,
        };
        prices.push(price);
        createdPrices.push(price);
        return price;
      },
    },
  };
}

describe('ensurePromoPrices', () => {
  it('creates founding CAD 7900 / USD 5900 yearly and Plus USD 1400 monthly / 11900 yearly', async () => {
    const { api, createdPrices } = fakeApi({});
    const result = await ensurePromoPrices(api);
    expect(createdPrices).toHaveLength(4);
    expect(createdPrices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'cad',
          unitAmount: FOUNDING_CAD_CENTS,
          interval: 'year',
          metadata: FOUNDING_PROMO_METADATA,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: FOUNDING_USD_CENTS,
          interval: 'year',
          metadata: FOUNDING_PROMO_METADATA,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: PLUS_USD_MONTHLY_CENTS,
          interval: 'month',
          metadata: PLUS_USD_LIST_METADATA,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: PLUS_USD_ANNUAL_CENTS,
          interval: 'year',
          metadata: PLUS_USD_LIST_METADATA,
        }),
      ]),
    );
    expect(FOUNDING_CAD_CENTS).toBe(7900);
    expect(FOUNDING_USD_CENTS).toBe(5900);
    expect(PLUS_USD_MONTHLY_CENTS).toBe(1400);
    expect(PLUS_USD_ANNUAL_CENTS).toBe(11900);
    expect(formatCreatedPriceIds(result).split('\n')).toEqual([
      `STRIPE_PRICE_FOUNDING_ANNUAL_CAD=${result.foundingCad}`,
      `STRIPE_PRICE_FOUNDING_ANNUAL_USD=${result.foundingUsd}`,
      `STRIPE_PRICE_PLUS_MONTHLY_USD=${result.plusMonthlyUsd}`,
      `STRIPE_PRICE_PLUS_ANNUAL_USD=${result.plusAnnualUsd}`,
    ]);
  });

  it('does nothing when prices tagged promo=founding-2026 and list=plus-usd already exist', async () => {
    const existing: StripePriceRecord[] = [
      {
        id: 'price_exist_cad',
        currency: 'cad',
        unitAmount: 7900,
        interval: 'year',
        metadata: { promo: 'founding-2026' },
        productId: 'prod_f',
      },
      {
        id: 'price_exist_usd',
        currency: 'usd',
        unitAmount: 5900,
        interval: 'year',
        metadata: { promo: 'founding-2026' },
        productId: 'prod_f',
      },
      {
        id: 'price_exist_mo',
        currency: 'usd',
        unitAmount: 1400,
        interval: 'month',
        metadata: { list: 'plus-usd' },
        productId: 'prod_p',
      },
      {
        id: 'price_exist_yr',
        currency: 'usd',
        unitAmount: 11900,
        interval: 'year',
        metadata: { list: 'plus-usd' },
        productId: 'prod_p',
      },
    ];
    const { api, createdPrices, createdProducts } = fakeApi({
      prices: existing,
      products: [
        { id: 'prod_f', name: 'Hale Founding Family', metadata: { promo: 'founding-2026' } },
        { id: 'prod_p', name: 'Hale Plus USD', metadata: { list: 'plus-usd' } },
      ],
    });
    const result = await ensurePromoPrices(api);
    expect(createdPrices).toEqual([]);
    expect(createdProducts).toEqual([]);
    expect(result).toEqual({
      foundingCad: 'price_exist_cad',
      foundingUsd: 'price_exist_usd',
      plusMonthlyUsd: 'price_exist_mo',
      plusAnnualUsd: 'price_exist_yr',
      created: [],
    });
    expect(formatCreatedPriceIds(result)).toBe('');
  });
});

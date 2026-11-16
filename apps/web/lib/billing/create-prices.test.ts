import { describe, expect, it } from 'vitest';
import {
  MAX_LIST_CAD_CENTS,
  MAX_LIST_CAD_METADATA,
  MAX_LIST_LOOKUP,
  MAX_LIST_USD_CENTS,
  MAX_LIST_USD_METADATA,
  PLUS_USD_ANNUAL_CENTS,
  PLUS_USD_LIST_METADATA,
  PLUS_USD_MONTHLY_CENTS,
  PROMO_LOOKUP,
  PROMO_MAX_CAD_CENTS,
  PROMO_MAX_USD_CENTS,
  PROMO_PLUS_CAD_CENTS,
  PROMO_PLUS_USD_CENTS,
  type StripeCatalogApi,
  type StripePriceRecord,
  type StripeProductRecord,
  ensurePromoPrices,
  formatCreatedPriceIds,
  promoPriceMetadata,
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
          lookupKey: input.lookupKey ?? null,
        };
        prices.push(price);
        createdPrices.push(price);
        return price;
      },
    },
  };
}

describe('ensurePromoPrices', () => {
  it('creates four promo yearly prices, Plus USD list, and Max list annual', async () => {
    const { api, createdPrices } = fakeApi({});
    const result = await ensurePromoPrices(api);
    expect(createdPrices).toHaveLength(8);
    expect(createdPrices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'cad',
          unitAmount: PROMO_PLUS_CAD_CENTS,
          interval: 'year',
          metadata: promoPriceMetadata('plus', 'cad'),
          lookupKey: PROMO_LOOKUP.plusCad,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: PROMO_PLUS_USD_CENTS,
          interval: 'year',
          metadata: promoPriceMetadata('plus', 'usd'),
          lookupKey: PROMO_LOOKUP.plusUsd,
        }),
        expect.objectContaining({
          currency: 'cad',
          unitAmount: PROMO_MAX_CAD_CENTS,
          interval: 'year',
          metadata: promoPriceMetadata('max', 'cad'),
          lookupKey: PROMO_LOOKUP.maxCad,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: PROMO_MAX_USD_CENTS,
          interval: 'year',
          metadata: promoPriceMetadata('max', 'usd'),
          lookupKey: PROMO_LOOKUP.maxUsd,
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
        expect.objectContaining({
          currency: 'cad',
          unitAmount: MAX_LIST_CAD_CENTS,
          interval: 'year',
          metadata: MAX_LIST_CAD_METADATA,
          lookupKey: MAX_LIST_LOOKUP.cad,
        }),
        expect.objectContaining({
          currency: 'usd',
          unitAmount: MAX_LIST_USD_CENTS,
          interval: 'year',
          metadata: MAX_LIST_USD_METADATA,
          lookupKey: MAX_LIST_LOOKUP.usd,
        }),
      ]),
    );
    expect(PROMO_PLUS_CAD_CENTS).toBe(5900);
    expect(PROMO_PLUS_USD_CENTS).toBe(3900);
    expect(PROMO_MAX_CAD_CENTS).toBe(9900);
    expect(PROMO_MAX_USD_CENTS).toBe(7900);
    expect(PLUS_USD_MONTHLY_CENTS).toBe(1400);
    expect(PLUS_USD_ANNUAL_CENTS).toBe(11900);
    expect(MAX_LIST_CAD_CENTS).toBe(32900);
    expect(MAX_LIST_USD_CENTS).toBe(25900);
    expect(formatCreatedPriceIds(result).split('\n')).toEqual([
      `STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD=${result.plusCad}`,
      `STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD=${result.plusUsd}`,
      `STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD=${result.maxCad}`,
      `STRIPE_PRICE_PROMO_MAX_ANNUAL_USD=${result.maxUsd}`,
      `STRIPE_PRICE_PLUS_MONTHLY_USD=${result.plusMonthlyUsd}`,
      `STRIPE_PRICE_PLUS_ANNUAL_USD=${result.plusAnnualUsd}`,
      `STRIPE_PRICE_MAX_ANNUAL_CAD=${result.maxAnnualCad}`,
      `STRIPE_PRICE_MAX_ANNUAL_USD=${result.maxAnnualUsd}`,
    ]);
  });

  it('does nothing when lookup-keyed promo prices and Plus USD list already exist', async () => {
    const existing: StripePriceRecord[] = [
      {
        id: 'price_exist_plus_cad',
        currency: 'cad',
        unitAmount: 5900,
        interval: 'year',
        metadata: promoPriceMetadata('plus', 'cad'),
        productId: 'prod_plus',
        lookupKey: PROMO_LOOKUP.plusCad,
      },
      {
        id: 'price_exist_plus_usd',
        currency: 'usd',
        unitAmount: 3900,
        interval: 'year',
        metadata: promoPriceMetadata('plus', 'usd'),
        productId: 'prod_plus',
        lookupKey: PROMO_LOOKUP.plusUsd,
      },
      {
        id: 'price_exist_max_cad',
        currency: 'cad',
        unitAmount: 9900,
        interval: 'year',
        metadata: promoPriceMetadata('max', 'cad'),
        productId: 'prod_max',
        lookupKey: PROMO_LOOKUP.maxCad,
      },
      {
        id: 'price_exist_max_usd',
        currency: 'usd',
        unitAmount: 7900,
        interval: 'year',
        metadata: promoPriceMetadata('max', 'usd'),
        productId: 'prod_max',
        lookupKey: PROMO_LOOKUP.maxUsd,
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
      {
        id: 'price_exist_max_list_cad',
        currency: 'cad',
        unitAmount: 32900,
        interval: 'year',
        metadata: { list: 'max-cad' },
        productId: 'prod_max',
        lookupKey: MAX_LIST_LOOKUP.cad,
      },
      {
        id: 'price_exist_max_list_usd',
        currency: 'usd',
        unitAmount: 25900,
        interval: 'year',
        metadata: { list: 'max-usd' },
        productId: 'prod_max',
        lookupKey: MAX_LIST_LOOKUP.usd,
      },
    ];
    const { api, createdPrices, createdProducts } = fakeApi({
      prices: existing,
      products: [
        { id: 'prod_plus', name: 'Hale Plus', metadata: { promo: 'holiday-2026', tier: 'plus' } },
        { id: 'prod_max', name: 'Hale Max', metadata: { promo: 'holiday-2026', tier: 'max' } },
        { id: 'prod_p', name: 'Hale Plus USD', metadata: { list: 'plus-usd' } },
      ],
    });
    const result = await ensurePromoPrices(api);
    expect(createdPrices).toEqual([]);
    expect(createdProducts).toEqual([]);
    expect(result).toEqual({
      plusCad: 'price_exist_plus_cad',
      plusUsd: 'price_exist_plus_usd',
      maxCad: 'price_exist_max_cad',
      maxUsd: 'price_exist_max_usd',
      plusMonthlyUsd: 'price_exist_mo',
      plusAnnualUsd: 'price_exist_yr',
      maxAnnualCad: 'price_exist_max_list_cad',
      maxAnnualUsd: 'price_exist_max_list_usd',
      created: [],
      wouldCreate: [],
    });
    expect(formatCreatedPriceIds(result)).toBe('');
  });

  it('dry-run lists missing env names and creates nothing', async () => {
    const { api, createdPrices } = fakeApi({});
    const result = await ensurePromoPrices(api, { apply: false });
    expect(createdPrices).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.wouldCreate).toEqual([
      'STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD',
      'STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD',
      'STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD',
      'STRIPE_PRICE_PROMO_MAX_ANNUAL_USD',
      'STRIPE_PRICE_PLUS_MONTHLY_USD',
      'STRIPE_PRICE_PLUS_ANNUAL_USD',
      'STRIPE_PRICE_MAX_ANNUAL_CAD',
      'STRIPE_PRICE_MAX_ANNUAL_USD',
    ]);
  });
});

/**
 * Idempotent Stripe price bootstrap for the 2026 holiday promo.
 *
 * Founding-family product: yearly CAD 7900 / USD 5900, metadata promo=founding-2026.
 * Plus USD list: monthly 1400 / yearly 11900, metadata list=plus-usd.
 *
 * Amounts live here and in tests/docs only. Runtime checkout never reads them —
 * it uses the price ids this script prints. Do not run against live Stripe from
 * an agent; the operator runs `pnpm stripe:create-founding-prices`.
 */

export const FOUNDING_CAD_CENTS = 7900;
export const FOUNDING_USD_CENTS = 5900;
export const PLUS_USD_MONTHLY_CENTS = 1400;
export const PLUS_USD_ANNUAL_CENTS = 11900;

export const FOUNDING_PROMO_METADATA = { promo: 'founding-2026' } as const;
export const PLUS_USD_LIST_METADATA = { list: 'plus-usd' } as const;

export const FOUNDING_PRODUCT_NAME = 'Hale Founding Family';
export const PLUS_USD_PRODUCT_NAME = 'Hale Plus USD';

export interface StripePriceRecord {
  readonly id: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly interval: 'month' | 'year';
  readonly metadata: Record<string, string>;
  readonly productId: string;
}

export interface StripeProductRecord {
  readonly id: string;
  readonly name: string;
  readonly metadata: Record<string, string>;
}

export interface StripeCatalogApi {
  listPrices(): Promise<StripePriceRecord[]>;
  listProducts(): Promise<StripeProductRecord[]>;
  createProduct(input: {
    name: string;
    metadata: Record<string, string>;
  }): Promise<StripeProductRecord>;
  createPrice(input: {
    productId: string;
    currency: string;
    unitAmount: number;
    interval: 'month' | 'year';
    metadata: Record<string, string>;
  }): Promise<StripePriceRecord>;
}

export interface PromoPriceSet {
  foundingCad: string;
  foundingUsd: string;
  plusMonthlyUsd: string;
  plusAnnualUsd: string;
  created: string[];
}

function matchPrice(
  prices: StripePriceRecord[],
  metadata: Record<string, string>,
  currency: string,
  unitAmount: number,
  interval: 'month' | 'year',
): StripePriceRecord | undefined {
  return prices.find(
    (price) =>
      price.currency === currency &&
      price.unitAmount === unitAmount &&
      price.interval === interval &&
      Object.entries(metadata).every(([key, value]) => price.metadata[key] === value),
  );
}

function matchProduct(
  products: StripeProductRecord[],
  metadata: Record<string, string>,
  name: string,
): StripeProductRecord | undefined {
  return products.find(
    (product) =>
      Object.entries(metadata).every(([key, value]) => product.metadata[key] === value) ||
      product.name === name,
  );
}

async function ensureProduct(
  api: StripeCatalogApi,
  products: StripeProductRecord[],
  name: string,
  metadata: Record<string, string>,
): Promise<string> {
  const existing = matchProduct(products, metadata, name);
  if (existing) return existing.id;
  const created = await api.createProduct({ name, metadata });
  products.push(created);
  return created.id;
}

async function ensurePrice(
  api: StripeCatalogApi,
  prices: StripePriceRecord[],
  created: string[],
  input: {
    productId: string;
    currency: string;
    unitAmount: number;
    interval: 'month' | 'year';
    metadata: Record<string, string>;
  },
): Promise<string> {
  const existing = matchPrice(
    prices,
    input.metadata,
    input.currency,
    input.unitAmount,
    input.interval,
  );
  if (existing) return existing.id;
  const price = await api.createPrice(input);
  prices.push(price);
  created.push(price.id);
  return price.id;
}

export async function ensurePromoPrices(api: StripeCatalogApi): Promise<PromoPriceSet> {
  const prices = await api.listPrices();
  const products = await api.listProducts();
  const created: string[] = [];

  const foundingProductId = await ensureProduct(
    api,
    products,
    FOUNDING_PRODUCT_NAME,
    FOUNDING_PROMO_METADATA,
  );
  const plusUsdProductId = await ensureProduct(
    api,
    products,
    PLUS_USD_PRODUCT_NAME,
    PLUS_USD_LIST_METADATA,
  );

  const foundingCad = await ensurePrice(api, prices, created, {
    productId: foundingProductId,
    currency: 'cad',
    unitAmount: FOUNDING_CAD_CENTS,
    interval: 'year',
    metadata: { ...FOUNDING_PROMO_METADATA },
  });
  const foundingUsd = await ensurePrice(api, prices, created, {
    productId: foundingProductId,
    currency: 'usd',
    unitAmount: FOUNDING_USD_CENTS,
    interval: 'year',
    metadata: { ...FOUNDING_PROMO_METADATA },
  });
  const plusMonthlyUsd = await ensurePrice(api, prices, created, {
    productId: plusUsdProductId,
    currency: 'usd',
    unitAmount: PLUS_USD_MONTHLY_CENTS,
    interval: 'month',
    metadata: { ...PLUS_USD_LIST_METADATA },
  });
  const plusAnnualUsd = await ensurePrice(api, prices, created, {
    productId: plusUsdProductId,
    currency: 'usd',
    unitAmount: PLUS_USD_ANNUAL_CENTS,
    interval: 'year',
    metadata: { ...PLUS_USD_LIST_METADATA },
  });

  return { foundingCad, foundingUsd, plusMonthlyUsd, plusAnnualUsd, created };
}

export function formatCreatedPriceIds(result: PromoPriceSet): string {
  const lines: string[] = [];
  const envById: Record<string, string> = {
    [result.foundingCad]: 'STRIPE_PRICE_FOUNDING_ANNUAL_CAD',
    [result.foundingUsd]: 'STRIPE_PRICE_FOUNDING_ANNUAL_USD',
    [result.plusMonthlyUsd]: 'STRIPE_PRICE_PLUS_MONTHLY_USD',
    [result.plusAnnualUsd]: 'STRIPE_PRICE_PLUS_ANNUAL_USD',
  };
  for (const id of result.created) {
    const env = envById[id];
    if (env) lines.push(`${env}=${id}`);
  }
  return lines.join('\n');
}

function form(body: Record<string, string>): URLSearchParams {
  return new URLSearchParams(body);
}

function stripeHeaders(secret: string): HeadersInit {
  return {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
}

async function stripeJson(
  secret: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: { ...stripeHeaders(secret), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`stripe ${path} failed: ${res.status}`);
  }
  return res.json();
}

function readMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

async function listAll(
  secret: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const data: unknown[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '100', active: 'true' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const json = (await stripeJson(secret, `${path}?${query.toString()}`, { method: 'GET' }, fetchImpl)) as {
      data?: unknown[];
      has_more?: boolean;
    };
    const batch = json.data ?? [];
    data.push(...batch);
    if (!json.has_more || batch.length === 0) break;
    const last = batch[batch.length - 1] as { id?: string };
    if (!last?.id) break;
    startingAfter = last.id;
  }
  return data;
}

/** Live Stripe API adapter. The CLI is the only caller. */
export function stripeCatalogApiFromSecret(
  secret: string,
  fetchImpl: typeof fetch = fetch,
): StripeCatalogApi {
  return {
    async listPrices() {
      const rows = await listAll(secret, 'prices', fetchImpl);
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const record = row as {
          id?: unknown;
          currency?: unknown;
          unit_amount?: unknown;
          recurring?: { interval?: unknown };
          metadata?: unknown;
          product?: unknown;
        };
        if (typeof record.id !== 'string') return [];
        const interval = record.recurring?.interval;
        if (interval !== 'month' && interval !== 'year') return [];
        if (typeof record.currency !== 'string' || typeof record.unit_amount !== 'number') {
          return [];
        }
        const productId =
          typeof record.product === 'string'
            ? record.product
            : record.product && typeof record.product === 'object' && 'id' in record.product
              ? String((record.product as { id: unknown }).id)
              : '';
        return [
          {
            id: record.id,
            currency: record.currency,
            unitAmount: record.unit_amount,
            interval,
            metadata: readMetadata(record.metadata),
            productId,
          },
        ];
      });
    },
    async listProducts() {
      const rows = await listAll(secret, 'products', fetchImpl);
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const record = row as { id?: unknown; name?: unknown; metadata?: unknown };
        if (typeof record.id !== 'string' || typeof record.name !== 'string') return [];
        return [{ id: record.id, name: record.name, metadata: readMetadata(record.metadata) }];
      });
    },
    async createProduct(input) {
      const body: Record<string, string> = { name: input.name };
      for (const [key, value] of Object.entries(input.metadata)) {
        body[`metadata[${key}]`] = value;
      }
      const json = (await stripeJson(
        secret,
        'products',
        { method: 'POST', body: form(body).toString() },
        fetchImpl,
      )) as { id: string; name: string; metadata?: Record<string, string> };
      return { id: json.id, name: json.name, metadata: json.metadata ?? {} };
    },
    async createPrice(input) {
      const body: Record<string, string> = {
        product: input.productId,
        currency: input.currency,
        unit_amount: String(input.unitAmount),
        'recurring[interval]': input.interval,
      };
      for (const [key, value] of Object.entries(input.metadata)) {
        body[`metadata[${key}]`] = value;
      }
      const json = (await stripeJson(
        secret,
        'prices',
        { method: 'POST', body: form(body).toString() },
        fetchImpl,
      )) as {
        id: string;
        currency: string;
        unit_amount: number;
        recurring?: { interval?: 'month' | 'year' };
        metadata?: Record<string, string>;
        product?: string;
      };
      return {
        id: json.id,
        currency: json.currency,
        unitAmount: json.unit_amount,
        interval: json.recurring?.interval === 'month' ? 'month' : 'year',
        metadata: json.metadata ?? {},
        productId: typeof json.product === 'string' ? json.product : input.productId,
      };
    },
  };
}

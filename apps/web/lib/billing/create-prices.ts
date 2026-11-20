/**
 * Idempotent Stripe price bootstrap for the 2026 holiday promo.
 *
 * Promo annual (lifetime lock, not a first-year coupon):
 *   Plus CAD 5900 / USD 3900, Max CAD 9900 / USD 7900.
 *   lookup_key hale_promo_{plus|max}_annual_{cad|usd}
 *   metadata { promo: holiday-2026, tier, currency }
 *
 * Plus USD list (after the cutoff): monthly 1400 / yearly 11900,
 * metadata list=plus-usd.
 *
 * Max list annual (after the cutoff, not purchasable during the window):
 *   CAD 32900 / USD 25900 on product Hale Max,
 *   lookup_key hale_list_max_annual_{cad|usd},
 *   metadata list=max-cad / max-usd.
 *
 * Amounts live here and in tests/docs only. Runtime checkout never reads them —
 * it uses the price ids this script prints. Do not run against live Stripe from
 * an agent; the operator runs `pnpm stripe:create-founding-prices` (dry-run
 * unless `--apply`).
 */

export const PROMO_PLUS_CAD_CENTS = 5900;
export const PROMO_PLUS_USD_CENTS = 3900;
export const PROMO_MAX_CAD_CENTS = 9900;
export const PROMO_MAX_USD_CENTS = 7900;
export const PLUS_USD_MONTHLY_CENTS = 1400;
export const PLUS_USD_ANNUAL_CENTS = 11900;
export const MAX_LIST_CAD_CENTS = 32900;
export const MAX_LIST_USD_CENTS = 25900;

/** @deprecated Plus promo CAD cents. Prefer PROMO_PLUS_CAD_CENTS. */
export const FOUNDING_CAD_CENTS = PROMO_PLUS_CAD_CENTS;
/** @deprecated Plus promo USD cents. Prefer PROMO_PLUS_USD_CENTS. */
export const FOUNDING_USD_CENTS = PROMO_PLUS_USD_CENTS;

export const HOLIDAY_PROMO = 'holiday-2026' as const;
export const PLUS_USD_LIST_METADATA = { list: 'plus-usd' } as const;
export const MAX_LIST_CAD_METADATA = { list: 'max-cad' } as const;
export const MAX_LIST_USD_METADATA = { list: 'max-usd' } as const;

/** Old Plus-only founding yearly prices (CAD 7900 / USD 5900). Lockdown archives these. */
export const LEGACY_FOUNDING_PROMO = 'founding-2026';
export const LEGACY_FOUNDING_LOOKUP_KEYS = [
  'hale_founding_annual_cad',
  'hale_founding_annual_usd',
] as const;

export const PLUS_PRODUCT_NAME = 'Hale Plus';
export const MAX_PRODUCT_NAME = 'Hale Max';
export const PLUS_USD_PRODUCT_NAME = 'Hale Plus USD';

export const PROMO_LOOKUP = {
  plusCad: 'hale_promo_plus_annual_cad',
  plusUsd: 'hale_promo_plus_annual_usd',
  maxCad: 'hale_promo_max_annual_cad',
  maxUsd: 'hale_promo_max_annual_usd',
} as const;

export const MAX_LIST_LOOKUP = {
  cad: 'hale_list_max_annual_cad',
  usd: 'hale_list_max_annual_usd',
} as const;

export function isLegacyFoundingPrice(price: {
  lookupKey?: string | null;
  metadata: Record<string, string>;
}): boolean {
  if (price.metadata.promo === LEGACY_FOUNDING_PROMO) return true;
  if (
    price.lookupKey &&
    (LEGACY_FOUNDING_LOOKUP_KEYS as readonly string[]).includes(price.lookupKey)
  ) {
    return true;
  }
  return false;
}

export function promoPriceMetadata(
  tier: 'plus' | 'max',
  currency: 'cad' | 'usd',
): { promo: typeof HOLIDAY_PROMO; tier: 'plus' | 'max'; currency: 'cad' | 'usd' } {
  return { promo: HOLIDAY_PROMO, tier, currency };
}

export interface StripePriceRecord {
  readonly id: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly interval: 'month' | 'year';
  readonly metadata: Record<string, string>;
  readonly productId: string;
  readonly lookupKey?: string | null;
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
    lookupKey?: string;
  }): Promise<StripePriceRecord>;
}

export interface PromoPriceSet {
  plusCad: string;
  plusUsd: string;
  maxCad: string;
  maxUsd: string;
  plusMonthlyUsd: string;
  plusAnnualUsd: string;
  maxAnnualCad: string;
  maxAnnualUsd: string;
  created: string[];
  wouldCreate: string[];
}

function matchPrice(
  prices: StripePriceRecord[],
  input: {
    metadata: Record<string, string>;
    currency: string;
    unitAmount: number;
    interval: 'month' | 'year';
    lookupKey?: string;
  },
): StripePriceRecord | undefined {
  if (input.lookupKey) {
    const byKey = prices.find((price) => price.lookupKey === input.lookupKey);
    if (byKey) return byKey;
  }
  return prices.find(
    (price) =>
      price.currency === input.currency &&
      price.unitAmount === input.unitAmount &&
      price.interval === input.interval &&
      Object.entries(input.metadata).every(([key, value]) => price.metadata[key] === value),
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
  apply: boolean,
): Promise<string | null> {
  const existing = matchProduct(products, metadata, name);
  if (existing) return existing.id;
  if (!apply) return null;
  const created = await api.createProduct({ name, metadata });
  products.push(created);
  return created.id;
}

async function ensurePrice(
  api: StripeCatalogApi,
  prices: StripePriceRecord[],
  created: string[],
  wouldCreate: string[],
  apply: boolean,
  envName: string,
  input: {
    productId: string | null;
    currency: string;
    unitAmount: number;
    interval: 'month' | 'year';
    metadata: Record<string, string>;
    lookupKey?: string;
  },
): Promise<string> {
  const existing = matchPrice(prices, input);
  if (existing) return existing.id;
  wouldCreate.push(envName);
  if (!apply || !input.productId) return '';
  const price = await api.createPrice({
    productId: input.productId,
    currency: input.currency,
    unitAmount: input.unitAmount,
    interval: input.interval,
    metadata: input.metadata,
    lookupKey: input.lookupKey,
  });
  prices.push(price);
  created.push(price.id);
  return price.id;
}

export async function ensurePromoPrices(
  api: StripeCatalogApi,
  options: { apply?: boolean } = {},
): Promise<PromoPriceSet> {
  const apply = options.apply !== false;
  const prices = await api.listPrices();
  const products = await api.listProducts();
  const created: string[] = [];
  const wouldCreate: string[] = [];

  const plusProductId = await ensureProduct(
    api,
    products,
    PLUS_PRODUCT_NAME,
    { promo: HOLIDAY_PROMO, tier: 'plus' },
    apply,
  );
  const maxProductId = await ensureProduct(
    api,
    products,
    MAX_PRODUCT_NAME,
    { promo: HOLIDAY_PROMO, tier: 'max' },
    apply,
  );
  const plusUsdProductId = await ensureProduct(
    api,
    products,
    PLUS_USD_PRODUCT_NAME,
    PLUS_USD_LIST_METADATA,
    apply,
  );

  const plusCad = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD',
    {
      productId: plusProductId,
      currency: 'cad',
      unitAmount: PROMO_PLUS_CAD_CENTS,
      interval: 'year',
      metadata: promoPriceMetadata('plus', 'cad'),
      lookupKey: PROMO_LOOKUP.plusCad,
    },
  );
  const plusUsd = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD',
    {
      productId: plusProductId,
      currency: 'usd',
      unitAmount: PROMO_PLUS_USD_CENTS,
      interval: 'year',
      metadata: promoPriceMetadata('plus', 'usd'),
      lookupKey: PROMO_LOOKUP.plusUsd,
    },
  );
  const maxCad = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD',
    {
      productId: maxProductId,
      currency: 'cad',
      unitAmount: PROMO_MAX_CAD_CENTS,
      interval: 'year',
      metadata: promoPriceMetadata('max', 'cad'),
      lookupKey: PROMO_LOOKUP.maxCad,
    },
  );
  const maxUsd = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PROMO_MAX_ANNUAL_USD',
    {
      productId: maxProductId,
      currency: 'usd',
      unitAmount: PROMO_MAX_USD_CENTS,
      interval: 'year',
      metadata: promoPriceMetadata('max', 'usd'),
      lookupKey: PROMO_LOOKUP.maxUsd,
    },
  );
  const plusMonthlyUsd = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PLUS_MONTHLY_USD',
    {
      productId: plusUsdProductId,
      currency: 'usd',
      unitAmount: PLUS_USD_MONTHLY_CENTS,
      interval: 'month',
      metadata: { ...PLUS_USD_LIST_METADATA },
    },
  );
  const plusAnnualUsd = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_PLUS_ANNUAL_USD',
    {
      productId: plusUsdProductId,
      currency: 'usd',
      unitAmount: PLUS_USD_ANNUAL_CENTS,
      interval: 'year',
      metadata: { ...PLUS_USD_LIST_METADATA },
    },
  );
  const maxAnnualCad = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_MAX_ANNUAL_CAD',
    {
      productId: maxProductId,
      currency: 'cad',
      unitAmount: MAX_LIST_CAD_CENTS,
      interval: 'year',
      metadata: { ...MAX_LIST_CAD_METADATA },
      lookupKey: MAX_LIST_LOOKUP.cad,
    },
  );
  const maxAnnualUsd = await ensurePrice(
    api,
    prices,
    created,
    wouldCreate,
    apply,
    'STRIPE_PRICE_MAX_ANNUAL_USD',
    {
      productId: maxProductId,
      currency: 'usd',
      unitAmount: MAX_LIST_USD_CENTS,
      interval: 'year',
      metadata: { ...MAX_LIST_USD_METADATA },
      lookupKey: MAX_LIST_LOOKUP.usd,
    },
  );

  return {
    plusCad,
    plusUsd,
    maxCad,
    maxUsd,
    plusMonthlyUsd,
    plusAnnualUsd,
    maxAnnualCad,
    maxAnnualUsd,
    created,
    wouldCreate,
  };
}

export function formatCreatedPriceIds(result: PromoPriceSet): string {
  const lines: string[] = [];
  const envById: Record<string, string> = {
    [result.plusCad]: 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD',
    [result.plusUsd]: 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD',
    [result.maxCad]: 'STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD',
    [result.maxUsd]: 'STRIPE_PRICE_PROMO_MAX_ANNUAL_USD',
    [result.plusMonthlyUsd]: 'STRIPE_PRICE_PLUS_MONTHLY_USD',
    [result.plusAnnualUsd]: 'STRIPE_PRICE_PLUS_ANNUAL_USD',
    [result.maxAnnualCad]: 'STRIPE_PRICE_MAX_ANNUAL_CAD',
    [result.maxAnnualUsd]: 'STRIPE_PRICE_MAX_ANNUAL_USD',
  };
  for (const id of result.created) {
    if (!id) continue;
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

async function listAll(secret: string, path: string, fetchImpl: typeof fetch): Promise<unknown[]> {
  const data: unknown[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '100', active: 'true' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const json = (await stripeJson(
      secret,
      `${path}?${query.toString()}`,
      { method: 'GET' },
      fetchImpl,
    )) as {
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
          lookup_key?: unknown;
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
            lookupKey: typeof record.lookup_key === 'string' ? record.lookup_key : null,
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
      if (input.lookupKey) body.lookup_key = input.lookupKey;
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
        lookup_key?: string | null;
      };
      return {
        id: json.id,
        currency: json.currency,
        unitAmount: json.unit_amount,
        interval: json.recurring?.interval === 'month' ? 'month' : 'year',
        metadata: json.metadata ?? {},
        productId: typeof json.product === 'string' ? json.product : input.productId,
        lookupKey: json.lookup_key ?? input.lookupKey ?? null,
      };
    },
  };
}

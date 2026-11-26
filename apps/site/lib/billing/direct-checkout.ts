import {
  ATTRIBUTION_KEYS,
  type Attribution,
  type BillingCurrency,
  isFoundingPromoWindowOpen,
  parseAttribution,
  parseFoundingPromoEndsAt,
} from '@hale/types';

/**
 * Price selection for a Checkout Session opened from /pricing, with no account.
 *
 * This mirrors `resolveCheckoutPrice` in apps/web/lib/billing/prices.ts. The site
 * cannot import that module. Amounts are display-only (`PROMO_PRICE_DISPLAY`);
 * the charge is the Stripe price id named here. A missing id is unavailable,
 * never a list price swapped in during the promo window.
 *
 * During the window (until 2027-01-01 00:00 America/Toronto) the id is
 * STRIPE_PRICE_PROMO_{PLUS,MAX}_ANNUAL_{CAD,USD}. After it, Plus uses the list
 * annual id and Max uses STRIPE_PRICE_MAX_ANNUAL_{CAD,USD}.
 */

const PROMO_PLUS_CAD = 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD';
const PROMO_PLUS_USD = 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD';
const PROMO_MAX_CAD = 'STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD';
const PROMO_MAX_USD = 'STRIPE_PRICE_PROMO_MAX_ANNUAL_USD';
const PLUS_ANNUAL_CAD = 'STRIPE_PRICE_PLUS_ANNUAL';
const PLUS_ANNUAL_USD = 'STRIPE_PRICE_PLUS_ANNUAL_USD';
const MAX_ANNUAL_CAD = 'STRIPE_PRICE_MAX_ANNUAL_CAD';
const MAX_ANNUAL_USD = 'STRIPE_PRICE_MAX_ANNUAL_USD';

export type DirectTier = 'plus' | 'family';
export type DirectSku = 'promo_plus_annual' | 'promo_max_annual' | 'plus_annual' | 'max_annual';

export type DirectCheckoutPrice =
  | {
      status: 'selected';
      priceId: string;
      sku: DirectSku;
      currency: BillingCurrency;
      tier: DirectTier;
    }
  | { status: 'unavailable'; reason: 'flag_off' | 'no_price' };

function trimId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function directCheckoutTier(value: string | null): DirectTier | null {
  const token = value?.trim().toLowerCase();
  if (token === 'plus') return 'plus';
  if (token === 'max' || token === 'family') return 'family';
  return null;
}

/** `max` in the URL is PlanTier `family`. */
export function directCheckoutTierQuery(tier: DirectTier): 'plus' | 'max' {
  return tier === 'family' ? 'max' : 'plus';
}

function promoId(
  tier: DirectTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined>,
): string | null {
  if (tier === 'family') {
    return currency === 'USD' ? trimId(env[PROMO_MAX_USD]) : trimId(env[PROMO_MAX_CAD]);
  }
  return currency === 'USD' ? trimId(env[PROMO_PLUS_USD]) : trimId(env[PROMO_PLUS_CAD]);
}

function listAnnualId(
  tier: DirectTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined>,
): string | null {
  if (tier === 'family') {
    return currency === 'USD' ? trimId(env[MAX_ANNUAL_USD]) : trimId(env[MAX_ANNUAL_CAD]);
  }
  return currency === 'USD' ? trimId(env[PLUS_ANNUAL_USD]) : trimId(env[PLUS_ANNUAL_CAD]);
}

export function selectDirectCheckoutPrice(input: {
  tier: DirectTier;
  currency: BillingCurrency;
  now: Date;
  env?: Record<string, string | undefined>;
}): DirectCheckoutPrice {
  const env = input.env ?? process.env;
  if (env.HOLIDAY_PROMO_ENABLED !== 'true') return { status: 'unavailable', reason: 'flag_off' };
  const windowOpen = isFoundingPromoWindowOpen(
    input.now,
    parseFoundingPromoEndsAt(env.PROMO_FOUNDING_ENDS_AT),
  );
  if (windowOpen) {
    const priceId = promoId(input.tier, input.currency, env);
    if (!priceId) return { status: 'unavailable', reason: 'no_price' };
    return {
      status: 'selected',
      priceId,
      sku: input.tier === 'family' ? 'promo_max_annual' : 'promo_plus_annual',
      currency: input.currency,
      tier: input.tier,
    };
  }
  const native = listAnnualId(input.tier, input.currency, env);
  if (native) {
    return {
      status: 'selected',
      priceId: native,
      sku: input.tier === 'family' ? 'max_annual' : 'plus_annual',
      currency: input.currency,
      tier: input.tier,
    };
  }
  if (
    input.tier === 'plus' &&
    env.CHECKOUT_SERVER_CURRENCY_ENABLED !== 'true' &&
    input.currency !== 'CAD'
  ) {
    const cad = listAnnualId('plus', 'CAD', env);
    if (cad) {
      return {
        status: 'selected',
        priceId: cad,
        sku: 'plus_annual',
        currency: 'CAD',
        tier: 'plus',
      };
    }
  }
  return { status: 'unavailable', reason: 'no_price' };
}

export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

export function directCheckoutSuccessUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/checkout/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`;
}

export function directCheckoutCancelUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/pricing?checkout=cancelled`;
}

/**
 * Hosted Checkout collects a phone when this is enabled, and the phone is required.
 * `card` is what turns on Apple Pay and Google Pay: they are wallets on the card
 * method, not their own `payment_method_types`. Hosted Checkout shows them on
 * checkout.stripe.com when the device supports them. That domain is Stripe's, so
 * villagehale.com and a Preview host do not register an Apple Pay domain for this
 * redirect. Link is listed beside card.
 */
export function directCheckoutForm(input: {
  priceId: string;
  tier: DirectTier;
  sku: DirectSku;
  currency: BillingCurrency;
  successUrl: string;
  cancelUrl: string;
  attribution?: Attribution;
}): URLSearchParams {
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    'phone_number_collection[enabled]': 'true',
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    'metadata[tier]': input.tier,
    'metadata[sku]': input.sku,
    'metadata[currency]': input.currency,
    'metadata[source]': 'pricing_direct',
    'subscription_data[metadata][tier]': input.tier,
    'subscription_data[metadata][sku]': input.sku,
    'subscription_data[metadata][currency]': input.currency,
    'subscription_data[metadata][source]': 'pricing_direct',
  });
  const attribution = input.attribution ?? {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (!value) continue;
    form.set(`metadata[${key}]`, value);
    form.set(`subscription_data[metadata][${key}]`, value);
  }
  return form;
}

export function attributionFromCheckoutUrl(url: URL): Attribution {
  return parseAttribution(url.searchParams);
}

/** A browser prefetch must not mint a Checkout Session. */
export function isCheckoutPrefetch(request: Request): boolean {
  const purpose = `${request.headers.get('purpose') ?? ''} ${request.headers.get('sec-purpose') ?? ''}`;
  if (purpose.toLowerCase().includes('prefetch')) return true;
  const next =
    request.headers.get('next-router-prefetch') ?? request.headers.get('x-middleware-prefetch');
  return next === '1';
}

export function stripeHostedCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

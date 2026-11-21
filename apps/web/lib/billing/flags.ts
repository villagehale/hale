/**
 * Holiday-promo and conversion-API gates. Env-only, exact `true`, default off.
 * Nothing in PostHog may turn a payment or an ads conversion on (PAYMENT_ENV_ONLY).
 */

export const HOLIDAY_PROMO_ENABLED_ENV = 'HOLIDAY_PROMO_ENABLED';
export const PROMO_NEW_VISITOR_CHECKOUT_ENABLED_ENV = 'PROMO_NEW_VISITOR_CHECKOUT_ENABLED';
export const CONVERSIONS_API_ENABLED_ENV = 'CONVERSIONS_API_ENABLED';
export const META_CAPI_ENABLED_ENV = 'META_CAPI_ENABLED';
/**
 * Checkout charges US → USD and CA → CAD from the geo header, refuses every
 * other country, and does not fall back from a missing USD list price to CAD.
 * Off unless the value is exactly `true`.
 */
export const CHECKOUT_SERVER_CURRENCY_ENABLED_ENV = 'CHECKOUT_SERVER_CURRENCY_ENABLED';
/**
 * Refund and dispute webhooks revoke the tier, checkout stays closed until a
 * signed billing event has been applied, and the reconcile cron pages #ops.
 * Off unless the value is exactly `true`. Signature verification itself still
 * follows STRIPE_WEBHOOK_SECRET and does not wait on this flag.
 */
export const STRIPE_BILLING_REVOKE_ENABLED_ENV = 'STRIPE_BILLING_REVOKE_ENABLED';
/**
 * A full refund of the charge that paid a subscription's current period drops the plan
 * and cancels that subscription in Stripe. Without the cancel, the renewal would charge
 * the parent again and its `invoice.paid` would re-grant the tier. Takes effect only with
 * STRIPE_BILLING_REVOKE_ENABLED also exactly `true`. Off unless the value is exactly `true`.
 */
export const STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED_ENV =
  'STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED';

export function holidayPromoEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[HOLIDAY_PROMO_ENABLED_ENV] === 'true';
}

export function promoNewVisitorCheckoutEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PROMO_NEW_VISITOR_CHECKOUT_ENABLED_ENV] === 'true';
}

export function conversionsApiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CONVERSIONS_API_ENABLED_ENV] === 'true';
}

export function metaCapiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[META_CAPI_ENABLED_ENV] === 'true';
}

export function checkoutServerCurrencyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CHECKOUT_SERVER_CURRENCY_ENABLED_ENV] === 'true';
}

export function stripeBillingRevokeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[STRIPE_BILLING_REVOKE_ENABLED_ENV] === 'true';
}

export function stripeRefundEndsSubscriptionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED_ENV] === 'true';
}

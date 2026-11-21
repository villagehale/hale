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
 * After a payment, cancel or refund, Hale writes the paying parent one text in their
 * existing 1:1 thread. Armed only together with {@link BILLING_THREAD_NOTICES_SINCE_ENV}:
 * the instant the flag went on, so an event from before it can never text anyone.
 */
export const BILLING_THREAD_NOTICES_ENABLED_ENV = 'BILLING_THREAD_NOTICES_ENABLED';
export const BILLING_THREAD_NOTICES_SINCE_ENV = 'BILLING_THREAD_NOTICES_SINCE';
/**
 * The checkout success page picks one state per buyer from Stripe and the DB.
 * Read by this app and by apps/site; both Vercel projects carry it. Off unless
 * the value is exactly `true`.
 */
export const CHECKOUT_SUCCESS_STATES_ENABLED_ENV = 'CHECKOUT_SUCCESS_STATES_ENABLED';

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

const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * When the billing notices lane was armed, or null while it is dark. On only for the exact
 * flag value and a strict UTC instant, so a stray newline or a bare date cannot arm it.
 * The round trip refuses a day the calendar does not have, which `Date` would roll over.
 */
export function billingThreadNoticesArmedAt(
  env: Record<string, string | undefined> = process.env,
): Date | null {
  if (env[BILLING_THREAD_NOTICES_ENABLED_ENV] !== 'true') return null;
  const since = env[BILLING_THREAD_NOTICES_SINCE_ENV];
  if (!since || !STRICT_UTC_INSTANT.test(since)) return null;
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 19) === since.slice(0, 19) ? at : null;
}

export function checkoutSuccessStatesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CHECKOUT_SUCCESS_STATES_ENABLED_ENV] === 'true';
}

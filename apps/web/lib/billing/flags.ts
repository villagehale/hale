/**
 * Holiday-promo and conversion-API gates. Env-only, exact `true`, default off.
 * Nothing in PostHog may turn a payment or an ads conversion on (PAYMENT_ENV_ONLY).
 */

export const HOLIDAY_PROMO_ENABLED_ENV = 'HOLIDAY_PROMO_ENABLED';
export const PROMO_NEW_VISITOR_CHECKOUT_ENABLED_ENV = 'PROMO_NEW_VISITOR_CHECKOUT_ENABLED';
export const CONVERSIONS_API_ENABLED_ENV = 'CONVERSIONS_API_ENABLED';
export const META_CAPI_ENABLED_ENV = 'META_CAPI_ENABLED';

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

import {
  type BillingCurrency,
  CANADA_PLUS_AFTER_LINE,
  FOUNDING_PRICE_DISPLAY,
  FOUNDING_PROMO_STARTS_AT,
  HOLIDAY_SALE_STARTS_AT,
  type PromoPhase,
  currencyFromIpCountry,
  isFoundingPromoWindowOpen,
  parseFoundingPromoEndsAt,
  promoPhaseAt,
} from '@hale/types';

/**
 * Holiday 2026 founding-family promo, as the marketing site shows it.
 *
 * Barton's decisions (Nov 2026), held here so every surface reads one source:
 *  - "Black Friday Sale" until Nov 27, then "Holiday Sale" from Nov 28 00:00
 *    America/Toronto to Dec 31. The phase is picked per request, so the switch
 *    needs no deploy.
 *  - Founding price C$79/yr (Canada) or US$59/yr (US), locked for as long as the
 *    family stays a member. Currency follows the visitor's country (US → USD,
 *    everything else → CAD), the same rule checkout uses.
 *  - Canadian surfaces always carry the Plus price after Dec 31. US surfaces never
 *    show a regular price beside the sale name.
 *  - Never was / save / % off / strikethrough beside "Sale".
 *
 * Display amounts come from @hale/types (FOUNDING_PRICE_DISPLAY), shared with the
 * app's founding checkout page. Checkout still charges whatever Stripe price id
 * the env names (apps/web/lib/billing/prices.ts).
 */

export type { PromoPhase };
export const PROMO_STARTS_AT = FOUNDING_PROMO_STARTS_AT;
export const HOLIDAY_PHASE_STARTS_AT = HOLIDAY_SALE_STARTS_AT;

export interface HolidayPromo {
  phase: PromoPhase;
  /** The sale name, which leads every promo surface. */
  saleName: 'Black Friday Sale' | 'Holiday Sale';
  currency: BillingCurrency;
  /** "C$" or "US$". */
  symbol: 'C$' | 'US$';
  /** Whole-unit founding price per year. */
  amount: 79 | 59;
  /** "C$79/yr" / "US$59/yr". */
  price: string;
  /** The required Canadian line. Null on US surfaces. */
  afterLine: string | null;
}

export const promoPhase = promoPhaseAt;

export function buildHolidayPromo(phase: PromoPhase, currency: BillingCurrency): HolidayPromo {
  const display = FOUNDING_PRICE_DISPLAY[currency];
  return {
    phase,
    saleName: phase === 'black_friday' ? 'Black Friday Sale' : 'Holiday Sale',
    currency,
    symbol: display.symbol,
    amount: display.amount as 79 | 59,
    price: display.perYear,
    afterLine: currency === 'USD' ? null : CANADA_PLUS_AFTER_LINE,
  };
}

type Env = Record<string, string | undefined>;

/**
 * The offer runs from PROMO_STARTS_AT to the founding cutoff
 * (PROMO_FOUNDING_ENDS_AT, default Dec 31 23:59 Toronto).
 */
export function promoWindowOpen(now: Date, env: Env = process.env): boolean {
  if (now.getTime() < new Date(PROMO_STARTS_AT).getTime()) return false;
  return isFoundingPromoWindowOpen(now, parseFoundingPromoEndsAt(env.PROMO_FOUNDING_ENDS_AT));
}

/**
 * Production shows the promo only when HOLIDAY_PROMO_ENABLED is exactly `true`
 * (the same switch that opens checkout in apps/web), so the page never sells a
 * price checkout can't take. Vercel Preview shows it so Design and Barton can
 * review before the flag flips.
 */
export function promoSwitchOn(env: Env = process.env): boolean {
  return env.HOLIDAY_PROMO_ENABLED === 'true' || env.VERCEL_ENV === 'preview';
}

export interface PromoOverrides {
  phase?: PromoPhase;
  country?: string;
  /** Force the promo on (true) or off (false) outside production. */
  show?: boolean;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Review-only query overrides (`?promo_phase=holiday&promo_cc=US`). Ignored in
 * production, so a shared ad link can never change what a parent is shown.
 */
export function promoOverrides(
  search: Record<string, string | string[] | undefined> | undefined,
  env: Env = process.env,
): PromoOverrides {
  if (env.VERCEL_ENV === 'production' || !search) return {};
  const out: PromoOverrides = {};
  const phase = first(search.promo_phase);
  if (phase === 'black_friday' || phase === 'holiday') out.phase = phase;
  const cc = first(search.promo_cc)?.trim().toUpperCase();
  if (cc && /^[A-Z]{2}$/.test(cc)) out.country = cc;
  const show = first(search.promo);
  if (show === 'on') out.show = true;
  if (show === 'off') out.show = false;
  return out;
}

/** The promo to render, or null when it is off, outside its window, or overridden off. */
export function resolveHolidayPromo(input: {
  now: Date;
  country: string | null | undefined;
  overrides?: PromoOverrides;
  env?: Env;
}): HolidayPromo | null {
  const env = input.env ?? process.env;
  const o = input.overrides ?? {};
  if (o.show === false) return null;
  const on = o.show === true || (promoSwitchOn(env) && promoWindowOpen(input.now, env));
  if (!on) return null;
  const currency = currencyFromIpCountry(o.country ?? input.country);
  return buildHolidayPromo(o.phase ?? promoPhase(input.now), currency);
}

import {
  type BillingCurrency,
  FOUNDING_PROMO_STARTS_AT,
  HOLIDAY_SALE_STARTS_AT,
  type PromoPhase,
  PROMO_PRICE_DISPLAY,
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
 *  - Both paid tiers are on sale, billed yearly, locked for as long as the
 *    family stays a member (Barton, Nov 16 1:07 PM ET):
 *      Canada: Plus $59/yr, Max $99/yr. US: Plus $39/yr, Max $79/yr.
 *    The headline leads with the Max price. Each sale price sits next to its
 *    regular annual price, struck through.
 *  - Plain "$" with no CAD / USD beside any price. The number itself follows
 *    the visitor's country (US → USD amounts, everything else → CAD amounts),
 *    the same rule checkout uses.
 *  - No monthly option and no "try it for a month" during the promo.
 *  - Never was / save / % off wording.
 *
 * DISPLAY ONLY. Checkout charges whatever Stripe price id the env names
 * (apps/web/lib/billing/prices.ts). Promo flags stay off in production until
 * Barton says go.
 */

export type { PromoPhase };
export const PROMO_STARTS_AT = FOUNDING_PROMO_STARTS_AT;
export const HOLIDAY_PHASE_STARTS_AT = HOLIDAY_SALE_STARTS_AT;

export type PromoTier = 'plus' | 'max';

/** One paid tier on sale: whole-unit amounts and the "$99/yr" labels. */
export interface PromoTierPrice {
  tier: PromoTier;
  name: 'Plus' | 'Max';
  /** Regular annual price, shown struck through. */
  regular: number;
  /** Sale annual price, locked in for founding families. */
  sale: number;
  /** "$329/yr" */
  regularLabel: string;
  /** "$99/yr" */
  saleLabel: string;
}

/**
 * Regular annual prices (struck through), from the list display in @hale/types:
 * Plus $159 / $119 (PLUS_LIST_PRICE_DISPLAY), Max $329 / $259
 * (MAX_LIST_PRICE_DISPLAY). The promo UI prints these as a plain "$".
 */
export const REGULAR_ANNUAL_DISPLAY: Record<BillingCurrency, Record<PromoTier, number>> = {
  CAD: { plus: 159, max: 329 },
  USD: { plus: 119, max: 259 },
};

/** Site tier name → the app's PlanTier (`family` is Max). */
export const PLAN_TIER: Record<PromoTier, 'plus' | 'family'> = { plus: 'plus', max: 'family' };

function tierPrice(currency: BillingCurrency, tier: PromoTier): PromoTierPrice {
  const regular = REGULAR_ANNUAL_DISPLAY[currency][tier];
  const sale = PROMO_PRICE_DISPLAY[PLAN_TIER[tier]][currency].amount;
  return {
    tier,
    name: tier === 'plus' ? 'Plus' : 'Max',
    regular,
    sale,
    regularLabel: `$${regular}/yr`,
    saleLabel: `$${sale}/yr`,
  };
}

export interface HolidayPromo {
  phase: PromoPhase;
  /** The sale name, which leads every promo surface. */
  saleName: 'Black Friday Sale' | 'Holiday Sale';
  /** Which amounts this visitor sees. Never printed next to a price. */
  currency: BillingCurrency;
  symbol: '$';
  plus: PromoTierPrice;
  max: PromoTierPrice;
}

/** Sits next to the sale prices. No trial or "try it for a month" wording. */
export const FOUNDING_REFUND_LINE = 'Full refund anytime if it’s not for you.';

export const promoPhase = promoPhaseAt;

export function buildHolidayPromo(phase: PromoPhase, currency: BillingCurrency): HolidayPromo {
  return {
    phase,
    saleName: phase === 'black_friday' ? 'Black Friday Sale' : 'Holiday Sale',
    currency,
    symbol: '$',
    plus: tierPrice(currency, 'plus'),
    max: tierPrice(currency, 'max'),
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

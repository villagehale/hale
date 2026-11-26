import {
  BLACK_FRIDAY_PRICE_DISPLAY,
  BLACK_FRIDAY_WINDOW_END_MS,
  type BillingCurrency,
  PROMO_PRICE_DISPLAY,
  currencyFromIpCountry,
  isBlackFridayWindowOpen,
  resolveBlackFridayNow,
  serverCheckoutCurrency,
} from '@hale/types';
import { bfAnnualPriceId } from '~/lib/billing/direct-checkout';
import type { PromoTier, PromoTierPrice } from './holiday';

/**
 * The one-day price, as the marketing site shows it.
 *
 * The server clock decides. Production ignores BLACK_FRIDAY_NOW_OVERRIDE,
 * ?bf=1 and ?bf_now. A tier with no Stripe price id is left on the regular
 * yearly amount, so the page never names a price checkout cannot charge.
 * Outside the window this returns null and every current surface stays put.
 */

type Env = Record<string, string | undefined>;
type Search = Record<string, string | string[] | undefined>;

export interface BlackFridayTier extends PromoTierPrice {
  /** "C$39" or "US$29". The cards keep the plain "$39/yr" labels. */
  banner: string;
}

export interface BlackFridayOffer {
  currency: BillingCurrency;
  endsAt: number;
  serverNow: number;
  plus: BlackFridayTier | null;
  max: BlackFridayTier | null;
  /** Appended to checkout links. Empty in production and when no force param was sent. */
  checkoutQuery: string;
}

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? null;
}

function displayCurrency(country: string | null | undefined, env: Env): BillingCurrency | null {
  if (env.CHECKOUT_SERVER_CURRENCY_ENABLED === 'true') return serverCheckoutCurrency(country);
  return currencyFromIpCountry(country);
}

function tierCard(currency: BillingCurrency, tier: PromoTier): BlackFridayTier {
  const plan = tier === 'max' ? 'family' : 'plus';
  const regular = PROMO_PRICE_DISPLAY[plan][currency].amount;
  const sale = BLACK_FRIDAY_PRICE_DISPLAY[plan][currency];
  return {
    tier,
    name: tier === 'plus' ? 'Plus' : 'Max',
    regular,
    sale: sale.amount,
    regularLabel: `$${regular}/yr`,
    saleLabel: sale.perYear,
    banner: sale.banner,
  };
}

/** Home share card, while the gate is open. No time zone. */
export const HOME_SHARE_ONE_DAY_ENDS = 'Ends Friday at midnight';

export function homeShareOneDayCopy(currency: BillingCurrency): { flag: string; prices: string } {
  const plus = BLACK_FRIDAY_PRICE_DISPLAY.plus[currency].banner;
  const max = BLACK_FRIDAY_PRICE_DISPLAY.family[currency].banner;
  return { flag: HOME_SHARE_ONE_DAY_ENDS, prices: `Plus ${plus}/yr · Max ${max}/yr` };
}

/**
 * The home /og card's one-day line. Null outside the gate, when the holiday
 * flag is off, or when either Stripe price id for this currency is missing,
 * so the card keeps the season line it can actually charge.
 */
export function homeShareOneDay(input: {
  now: Date;
  currency: BillingCurrency;
  env?: Env;
  bf?: string | null;
  bfNow?: string | null;
}): { flag: string; prices: string } | null {
  const env = input.env ?? process.env;
  if (env.HOLIDAY_PROMO_ENABLED !== 'true') return null;
  const clock = resolveBlackFridayNow({
    now: input.now,
    env,
    bf: input.bf,
    bfNow: input.bfNow,
  });
  if (!isBlackFridayWindowOpen(clock)) return null;
  if (!bfAnnualPriceId('plus', input.currency, env)) return null;
  if (!bfAnnualPriceId('family', input.currency, env)) return null;
  return homeShareOneDayCopy(input.currency);
}

export function blackFridayCheckoutQuery(input: {
  env: Env;
  bf?: string | null;
  bfNow?: string | null;
}): string {
  if (input.env.VERCEL_ENV === 'production') return '';
  const params = new URLSearchParams();
  if (input.bf?.trim() === '1') params.set('bf', '1');
  const bfNow = input.bfNow?.trim();
  if (bfNow && !Number.isNaN(new Date(bfNow).getTime())) params.set('bf_now', bfNow);
  return params.toString();
}

/** Null outside the window, when checkout is off, or when neither price id is set. */
export function resolveBlackFridayOffer(input: {
  now: Date;
  country: string | null | undefined;
  env?: Env;
  bf?: string | null;
  bfNow?: string | null;
}): BlackFridayOffer | null {
  const env = input.env ?? process.env;
  if (env.HOLIDAY_PROMO_ENABLED !== 'true') return null;
  const clock = resolveBlackFridayNow({
    now: input.now,
    env,
    bf: input.bf,
    bfNow: input.bfNow,
  });
  if (!isBlackFridayWindowOpen(clock)) return null;
  const currency = displayCurrency(input.country, env);
  if (!currency) return null;
  const plusId = bfAnnualPriceId('plus', currency, env);
  const maxId = bfAnnualPriceId('family', currency, env);
  if (!plusId && !maxId) return null;
  return {
    currency,
    endsAt: BLACK_FRIDAY_WINDOW_END_MS,
    serverNow: clock.getTime(),
    plus: plusId ? tierCard(currency, 'plus') : null,
    max: maxId ? tierCard(currency, 'max') : null,
    checkoutQuery: blackFridayCheckoutQuery({ env, bf: input.bf, bfNow: input.bfNow }),
  };
}

export function resolveBlackFridayFromSearch(input: {
  now: Date;
  country: string | null | undefined;
  search?: Search;
  env?: Env;
}): BlackFridayOffer | null {
  return resolveBlackFridayOffer({
    now: input.now,
    country: input.country,
    env: input.env,
    bf: first(input.search?.bf),
    bfNow: first(input.search?.bf_now),
  });
}

export function blackFridaySentence(
  locale: 'en' | 'fr' | 'zh',
  plus: string | null,
  max: string | null,
): string {
  if (locale === 'fr') {
    if (plus && max) {
      return `Black Friday : Plus ${plus} et Max ${max} par année, aujourd'hui seulement.`;
    }
    if (plus) return `Black Friday : Plus ${plus} par année, aujourd'hui seulement.`;
    return `Black Friday : Max ${max} par année, aujourd'hui seulement.`;
  }
  if (locale === 'zh') {
    if (plus && max) return `黑色星期五：年付 Plus ${plus}、Max ${max}，仅限今日。`;
    if (plus) return `黑色星期五：年付 Plus ${plus}，仅限今日。`;
    return `黑色星期五：年付 Max ${max}，仅限今日。`;
  }
  if (plus && max) return `Black Friday: yearly Plus ${plus} and Max ${max}, today only.`;
  if (plus) return `Black Friday: yearly Plus ${plus}, today only.`;
  return `Black Friday: yearly Max ${max}, today only.`;
}

/**
 * The Dec 31 sentence keeps the season amounts. Today's price is named on
 * its own, so a later buyer is not told the one-day price lasts the month.
 */
export function blackFridayDeadlineCopy(input: {
  plusToday: string | null;
  maxToday: string | null;
  plusSeason: string;
  maxSeason: string;
}): string {
  const today = [
    input.plusToday ? `Plus is ${input.plusToday}` : null,
    input.maxToday ? `Max is ${input.maxToday}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' and ');
  return `${today} today. Join by Dec 31 and Plus is ${input.plusSeason}, Max is ${input.maxSeason}, for as long as you’re a member.`;
}

/**
 * The countdown sentence. Null once the visitor's Friday has ended, including
 * zero remaining. Callers must not substitute an "ended" line.
 */
export function blackFridayCountdownCopy(
  locale: 'en' | 'fr' | 'zh',
  remainingMs: number,
): string | null {
  if (remainingMs <= 0) return null;
  if (locale === 'fr') return 'Se termine vendredi à minuit';
  if (locale === 'zh') return '周五午夜结束';
  return 'Ends Friday at midnight';
}

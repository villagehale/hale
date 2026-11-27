import {
  BLACK_FRIDAY_PRICE_DISPLAY,
  BLACK_FRIDAY_WINDOW_END_MS,
  type BillingCurrency,
  PROMO_PRICE_DISPLAY,
  blackFridayCountdownClock,
  currencyFromIpCountry,
  isBlackFridayWindowOpen,
  resolveBlackFridayNow,
  serverCheckoutCurrency,
} from '@hale/types';
import { bfAnnualPriceId } from '~/lib/billing/direct-checkout';
import { FOUNDING_REFUND_LINE, type PromoTier, type PromoTierPrice } from './holiday';

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
  /** Plain dollars, "$39". The cards and buttons use "$39/yr". */
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

/** "$39/yr" in the page's money style. An unrecognized label is returned as-is. */
export function blackFridayPriceLabel(locale: 'en' | 'fr' | 'zh', saleLabel: string): string {
  const amount = saleLabel.match(/\$(\d+)/)?.[1];
  if (!amount) return saleLabel;
  if (locale === 'fr') return `${amount} $/an`;
  if (locale === 'zh') return `每年 $${amount}`;
  return saleLabel;
}

function blackFridayPlanName(plan: 'plus' | 'max'): 'Plus' | 'Max' {
  return plan === 'plus' ? 'Plus' : 'Max';
}

/** Today's price, and that it stays at renewal. No season amount. */
export function blackFridayRenewalCopy(
  locale: 'en' | 'fr' | 'zh',
  plus: string | null,
  max: string | null,
): string {
  const named = (plan: 'Plus' | 'Max', label: string): string => {
    const price = blackFridayPriceLabel(locale, label);
    if (locale === 'fr') return `${plan} coûte ${price}`;
    if (locale === 'zh') return `${plan} ${price}`;
    return `${plan} is ${price}`;
  };
  const parts = [
    plus ? named('Plus', plus) : null,
    max ? named('Max', max) : null,
  ].filter((part): part is string => part !== null);
  const stays =
    locale === 'fr'
      ? 'Ce prix reste quand tu renouvelles.'
      : locale === 'zh'
        ? '续订时这个价格不变。'
        : 'This price stays when you renew.';
  if (locale === 'zh') return `今日 ${parts.join('，')}。${stays}`;
  if (locale === 'fr') return `${parts.join(' et ')} aujourd'hui. ${stays}`;
  return `${parts.join(' and ')} today. ${stays}`;
}

/** The checkout button. "Get Plus, $39/yr", and the tu / 开通 forms. */
export function blackFridayPlanButton(
  locale: 'en' | 'fr' | 'zh',
  plan: 'plus' | 'max',
  saleLabel: string,
): string {
  const name = blackFridayPlanName(plan);
  const price = blackFridayPriceLabel(locale, saleLabel);
  if (locale === 'fr') return `Prends ${name}, ${price}`;
  if (locale === 'zh') return `开通 ${name}，${price}`;
  return `Get ${name}, ${price}`;
}

export function blackFridayMaxHeadline(locale: 'en' | 'fr' | 'zh', saleLabel: string): string {
  const price = blackFridayPriceLabel(locale, saleLabel);
  if (locale === 'fr') return `Black Friday : Max à ${price}.`;
  if (locale === 'zh') return `黑色星期五：Max ${price}。`;
  return `Black Friday: Max for ${price}.`;
}

export function blackFridayCloseHeadline(locale: 'en' | 'fr' | 'zh', saleLabel: string): string {
  const price = blackFridayPriceLabel(locale, saleLabel);
  if (locale === 'fr') return `Max à ${price}, aujourd'hui.`;
  if (locale === 'zh') return `今日 Max ${price}。`;
  return `Max for ${price}, today.`;
}

export function blackFridayTodayTag(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return "Aujourd'hui seulement.";
  if (locale === 'zh') return '仅限今日。';
  return 'Today only.';
}

export function blackFridayYearlyNote(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return "Plus et Max sont facturés à l'année. Ce prix reste quand tu renouvelles.";
  if (locale === 'zh') return 'Plus 和 Max 按年计费。续订时这个价格不变。';
  return 'Plus and Max are billed yearly. This price stays when you renew.';
}

export function blackFridayRefundLine(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return "Remboursement complet en tout temps si ce n'est pas pour toi.";
  if (locale === 'zh') return '不合适可随时全额退款。';
  return FOUNDING_REFUND_LINE;
}

/** What a screen reader hears for the struck price beside today's price. */
export function blackFridayHeardPrice(
  locale: 'en' | 'fr' | 'zh',
  saleLabel: string,
  regularLabel: string,
): string {
  if (locale === 'fr') {
    return `${blackFridayPriceLabel('fr', saleLabel)}, prix habituel ${blackFridayPriceLabel('fr', regularLabel)}.`;
  }
  if (locale === 'zh') {
    return `${blackFridayPriceLabel('zh', saleLabel)}，原价 ${blackFridayPriceLabel('zh', regularLabel)}。`;
  }
  return `${saleLabel.replace('/yr', ' a year')}, regular price ${regularLabel.replace('/yr', ' a year')}.`;
}

/** Mobile top bar and the sticky. Desktop uses "Ends in" beside the clock. */
export function blackFridayEndsLine(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return 'Se termine à minuit.';
  if (locale === 'zh') return '午夜结束。';
  return 'Ends at midnight.';
}

/** Today's price on the mobile bar and the sticky. No strike, no unit. */
export function blackFridayShortPriceLine(locale: 'en' | 'fr' | 'zh', offer: BlackFridayOffer): string {
  const bits: string[] = [];
  if (offer.plus) bits.push(`Plus ${blackFridayPlainAmount(locale, offer.plus.sale, false)}`);
  if (offer.max) bits.push(`Max ${blackFridayPlainAmount(locale, offer.max.sale, false)}`);
  return bits.join(' · ');
}

/** Words beside the clock on the top bar. Hidden with the chip once Friday ends. */
export function blackFridayEndsInLabel(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return 'Fin dans';
  if (locale === 'zh') return '距结束';
  return 'Ends in';
}

/** The × control. Session-only; checkout is unchanged. */
export function blackFridayCloseLabel(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return 'Fermer';
  if (locale === 'zh') return '关闭';
  return 'Close';
}

/** Accessible name for the bar link. Prices are today's, with the unit. */
export function blackFridayBarLabel(locale: 'en' | 'fr' | 'zh', offer: BlackFridayOffer): string {
  const bits: string[] = [];
  if (offer.plus) bits.push(`Plus ${blackFridayPlainAmount(locale, offer.plus.sale, true)}`);
  if (offer.max) bits.push(`Max ${blackFridayPlainAmount(locale, offer.max.sale, true)}`);
  const see = blackFridaySeePrices(locale);
  const prices = bits.join(' · ');
  if (locale === 'zh') return `Black Friday。${prices}。${see}`;
  return `Black Friday. ${prices}. ${see}.`;
}

/** Under the clock digits. Not uppercased. */
export function blackFridayClockLabels(locale: 'en' | 'fr' | 'zh'): readonly [string, string, string] {
  if (locale === 'fr') return ['h', 'min', 's'];
  if (locale === 'zh') return ['时', '分', '秒'];
  return ['hrs', 'min', 'sec'];
}

/** The only banner and sticky action. Locale-prefixed `/pricing`. */
export function blackFridaySeePrices(locale: 'en' | 'fr' | 'zh'): string {
  if (locale === 'fr') return 'Voir les prix';
  if (locale === 'zh') return '查看价格';
  return 'See prices';
}

/** sessionStorage. Set by either close button. Both bars read it. */
export const BLACK_FRIDAY_DISMISS_KEY = 'hale_bf_dismissed';

/** Plain dollars. The strike omits the unit; the sale keeps it. */
export function blackFridayPlainAmount(
  locale: 'en' | 'fr' | 'zh',
  amount: number,
  withUnit: boolean,
): string {
  if (locale === 'fr') return withUnit ? `${amount} $/an` : `${amount} $`;
  if (locale === 'zh') return withUnit ? `$${amount}/年` : `$${amount}`;
  return withUnit ? `$${amount}/yr` : `$${amount}`;
}

/**
 * The words beside the clock. Null once the visitor's Friday has ended,
 * including zero remaining. Callers must not substitute an "ended" line.
 */
export function blackFridayCountdownCopy(
  locale: 'en' | 'fr' | 'zh',
  remainingMs: number,
): string | null {
  if (remainingMs <= 0) return null;
  return blackFridayEndsInLabel(locale);
}

/** Width reserved for the ticking clock before the visitor's zone is known. */
export const BLACK_FRIDAY_COUNTDOWN_HOLD = '88:88:88';

/** The clock line. Hidden with the label at zero. */
export function blackFridayEndsInCopy(locale: 'en' | 'fr' | 'zh', clock: string): string {
  return `${blackFridayEndsInLabel(locale)} ${clock}`;
}

export function blackFridayCountdownPair(
  locale: 'en' | 'fr' | 'zh',
  remainingMs: number,
): { when: string; left: string } | null {
  const when = blackFridayCountdownCopy(locale, remainingMs);
  if (!when) return null;
  return { when, left: blackFridayEndsInCopy(locale, blackFridayCountdownClock(remainingMs)) };
}

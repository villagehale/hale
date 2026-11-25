import { type BillingCurrency, type PromoPhase, currencyFromIpCountry } from '@hale/types';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { tx } from '~/components/redesign/tx';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { SITE_URL } from '~/lib/app-url';
import {
  type HolidayPromo,
  type PromoOverrides,
  buildHolidayPromo,
  promoOverrides,
  promoPhase,
  resolveHolidayPromo,
} from '~/lib/promo/holiday';
import { SHARE_SEARCH_HEADER } from '~/lib/site/share-search-header';

/**
 * Style D share cards. The image URL is the cache key: version, locale, sale
 * phase, currency, and whether the offer is on. Twitter refetches when any of
 * those change, including the Dec 1 phase switch, without a new deploy.
 *
 * The phase, the offer, and the prices come from the same helpers the holiday
 * banner uses. A page passes the request clock and the review query
 * (`?promo_phase=holiday` on Preview). The image route paints whatever the URL
 * says, so a crawler that saved the URL gets that card.
 */
export const SHARE_CARD_VERSION = 'd3';
export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

export const SHARE_CARD_IDS = [
  'home',
  'pricing',
  'faq',
  'about',
  'activities',
  'answers',
  'contact',
  'privacy',
  'terms',
  'not-found',
  'text',
  'checkout',
] as const;

export type ShareCardId = (typeof SHARE_CARD_IDS)[number];

export function isShareCardId(value: string): value is ShareCardId {
  return (SHARE_CARD_IDS as readonly string[]).includes(value);
}

export interface ShareCardQuery {
  locale: Locale;
  phase: PromoPhase;
  currency: BillingCurrency;
  /** The holiday offer is on, so the card paints the sale name and both yearly prices. */
  offer: boolean;
  /** Checkout only. The paid confirmation heading, otherwise the unpaid one. */
  paid: boolean;
}

export type ShareSearch = { [key: string]: string | string[] | undefined } | undefined;

type Env = Record<string, string | undefined>;

export function shareCardQueryFrom(input: {
  locale: Locale;
  now?: Date;
  search?: ShareSearch;
  country?: string | null;
  env?: Env;
  paid?: boolean;
}): ShareCardQuery {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const overrides: PromoOverrides = promoOverrides(input.search, env);
  const country = overrides.country ?? input.country;
  const promo = resolveHolidayPromo({ now, country, overrides, env });
  const currency = promo?.currency ?? currencyFromIpCountry(country);
  return {
    locale: input.locale,
    phase: promo?.phase ?? overrides.phase ?? promoPhase(now),
    currency,
    offer: promo !== null,
    paid: input.paid === true,
  };
}

/** Clock, flag, and country, with no review query. Tests and the bare image URL use this. */
export function defaultShareQuery(
  locale: Locale,
  now = new Date(),
  env: Env = process.env,
): ShareCardQuery {
  return shareCardQueryFrom({ locale, now, env });
}

/** The middleware stamps the raw query. The 404 layout metadata reads it back. */
export function searchFromShareHeader(raw: string | null): ShareSearch {
  if (!raw) return undefined;
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const search: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    search[key] = values.length > 1 ? values : values[0];
  }
  return search;
}

/**
 * Request-time query. `connection()` keeps the phase off the build clock, so
 * the Dec 1 switch happens on the next request. Outside a request (unit tests,
 * the local render script) the clock and the process env still decide.
 *
 * A page passes `searchParams` when Next gives them to it. The 404 does not
 * (it is metadata on the layout), so the query comes from the header the
 * middleware stamps onto the same request.
 */
export async function shareQueryForRequest(
  locale: Locale,
  search?: ShareSearch,
  paid = false,
): Promise<ShareCardQuery> {
  try {
    await connection();
  } catch {
    // No request store.
  }
  let country: string | null = null;
  let resolved = search;
  try {
    const headerStore = await headers();
    country = headerStore.get('x-vercel-ip-country');
    if (!resolved) resolved = searchFromShareHeader(headerStore.get(SHARE_SEARCH_HEADER));
  } catch {
    country = null;
  }
  return shareCardQueryFrom({ locale, search: resolved, country, paid });
}

export function shareCardQueryFromUrl(url: URL): ShareCardQuery {
  const localeRaw = url.searchParams.get('locale');
  const locale: Locale = localeRaw === 'fr' || localeRaw === 'zh' ? localeRaw : 'en';
  const fallback = defaultShareQuery(locale);
  const phaseRaw = url.searchParams.get('phase');
  const ccRaw = url.searchParams.get('cc');
  const offerRaw = url.searchParams.get('offer');
  const paidRaw = url.searchParams.get('paid');
  return {
    locale,
    phase: phaseRaw === 'holiday' || phaseRaw === 'black_friday' ? phaseRaw : fallback.phase,
    currency: ccRaw === 'USD' || ccRaw === 'CAD' ? ccRaw : fallback.currency,
    offer: offerRaw === '1' ? true : offerRaw === '0' ? false : fallback.offer,
    paid: paidRaw === '1' ? true : paidRaw === '0' ? false : fallback.paid,
  };
}

/**
 * Site price cards print a bare "$" for both currencies. A share card has no
 * other currency cue, so CAD is C$ and USD stays that same bare "$".
 */
export function sharePriceLabel(currency: BillingCurrency, label: string): string {
  if (currency === 'CAD' && label.startsWith('$')) return `C${label}`;
  return label;
}

export function shareCardQueryString(query: ShareCardQuery): string {
  return [
    `v=${SHARE_CARD_VERSION}`,
    `locale=${query.locale}`,
    `phase=${query.phase}`,
    `cc=${query.currency}`,
    `offer=${query.offer ? '1' : '0'}`,
    `paid=${query.paid ? '1' : '0'}`,
  ].join('&');
}

export function shareCardUrl(id: string, query: ShareCardQuery = defaultShareQuery('en')): string {
  return `${SITE_URL}/og/${id}?${shareCardQueryString(query)}`;
}

export function answerShareUrl(
  slug: string,
  query: ShareCardQuery = defaultShareQuery('en'),
): string {
  return `${SITE_URL}/og/answers/${slug}?${shareCardQueryString(query)}`;
}

/**
 * The home line. The second clause is the opening of the existing
 * "We're in, I can drive" string in each locale file. The frame is that
 * headline in the same voice the page already uses (tu / on, 我们).
 */
export const HOME_SLOGAN: Record<
  Locale,
  { lead: string; quote: string; bridge: string; marked: string; plain: string }
> = {
  en: {
    lead: 'From',
    quote: '“we should”',
    bridge: 'to',
    marked: '“we’re in.”',
    plain: 'From “we should” to “we’re in.”',
  },
  fr: {
    lead: 'De',
    quote: '« on devrait »',
    bridge: 'à',
    marked: '« on est partants. »',
    plain: 'De « on devrait » à « on est partants. »',
  },
  zh: {
    lead: '从「我们应该」',
    quote: '',
    bridge: '',
    marked: '到「我们去。」',
    plain: '从「我们应该」到「我们去。」',
  },
};

export interface ShareThreadLine {
  from: 'hale' | 'priya' | 'me';
  /** Shown above the first bubble in a run. The outgoing reply has none. */
  name: string;
  text: string;
}

export interface PaintedShareCard {
  id: ShareCardId | 'answer';
  alt: string;
  locale: Locale;
  /** Handwriting face for the headline. Chinese uses the handwriting CJK face. */
  headlineFont: 'Caveat Brush' | 'Ma Shan Zheng';
  slogan: (typeof HOME_SLOGAN)[Locale] | null;
  headline: string;
  flag: string | null;
  prices: string | null;
  footer: Array<{ text: string; font: 'DM Mono' | 'Ma Shan Zheng' }>;
  chat: {
    group: string;
    delivered: string;
    lines: ShareThreadLine[];
  };
}

function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function footerLine(locale: Locale): PaintedShareCard['footer'] {
  const t = getTranslator(locale, 'Footer');
  const prefix = `${t('pronunciationPrefix')} ${t('pronunciation')} `;
  const suffix = t('pronunciationSuffix');
  // The Chinese suffix is the only run that needs the handwriting CJK face.
  // The name and the pronunciation stay in the mono face every other card uses.
  if (locale === 'zh') {
    return [
      { text: prefix, font: 'DM Mono' },
      { text: suffix, font: 'Ma Shan Zheng' },
    ];
  }
  return [{ text: `${prefix}${suffix}`, font: 'DM Mono' }];
}

function pageHeadline(
  id: ShareCardId,
  locale: Locale,
  promo: HolidayPromo | null,
  paid: boolean,
): string {
  switch (id) {
    case 'home':
      return HOME_SLOGAN[locale].plain;
    case 'pricing':
      if (promo && locale === 'en') {
        const max = sharePriceLabel(promo.currency, promo.max.saleLabel);
        return `${promo.saleName}: Max for ${max}.`;
      }
      return tx(locale, 'Plus, by the year or the month.');
    case 'faq':
      return tx(locale, 'Is Hale right for your family?');
    case 'about':
      return tx(locale, 'A planner for your kids’ year.');
    case 'activities':
      return tx(locale, 'Things to do with your kids, near you.');
    case 'answers':
      return tx(locale, 'Calm, cited guidance for every stage.');
    case 'contact':
      return tx(locale, 'Say hello.');
    case 'text':
      return tx(locale, 'Text Hale like you’d text a friend.');
    case 'privacy':
      return 'Privacy Policy';
    case 'terms':
      return 'Terms of Service';
    case 'not-found': {
      const title = getTranslator(locale, 'Common')('notFoundTitle');
      const suffix = ' · Hale';
      return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
    }
    case 'checkout':
      return getTranslator(locale, 'CheckoutSuccess')(paid ? 'heading' : 'unpaidHeading');
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/** Three earlier Hale bubbles, then the saturday yes already on the card. */
function thread(locale: Locale): ShareThreadLine[] {
  return [
    { from: 'hale', name: 'Hale', text: tx(locale, 'tot gym, sat 9:30am') },
    { from: 'hale', name: 'Hale', text: tx(locale, 'at the community centre') },
    { from: 'hale', name: 'Hale', text: tx(locale, 'saturday morning, if you want it') },
    { from: 'priya', name: 'Priya', text: tx(locale, 'we should do something saturday') },
    { from: 'me', name: '', text: tx(locale, 'we’re in') },
  ];
}

function paint(
  id: ShareCardId | 'answer',
  headline: string,
  query: ShareCardQuery,
  slogan: PaintedShareCard['slogan'],
): PaintedShareCard {
  const promo = query.offer ? buildHolidayPromo(query.phase, query.currency) : null;
  const max = promo ? sharePriceLabel(promo.currency, promo.max.saleLabel) : null;
  const plus = promo ? sharePriceLabel(promo.currency, promo.plus.saleLabel) : null;
  const prices = max && plus ? `Max ${max} · Plus ${plus}` : null;
  return {
    id,
    alt: `Hale. ${headline}`,
    locale: query.locale,
    headlineFont: hasHan(headline) ? 'Ma Shan Zheng' : 'Caveat Brush',
    slogan,
    headline,
    flag: promo?.saleName ?? null,
    prices,
    footer: footerLine(query.locale),
    chat: {
      group: tx(query.locale, 'Saturday crew'),
      delivered: tx(query.locale, 'Delivered'),
      lines: thread(query.locale),
    },
  };
}

export function paintShareCard(id: ShareCardId, query: ShareCardQuery): PaintedShareCard {
  const promo = query.offer ? buildHolidayPromo(query.phase, query.currency) : null;
  const headline = pageHeadline(id, query.locale, promo, query.paid);
  const slogan = id === 'home' ? HOME_SLOGAN[query.locale] : null;
  return paint(id, headline, query, slogan);
}

/** Article cards use the guide's H1, which is the question, in every locale. */
export function paintAnswerCard(question: string, query: ShareCardQuery): PaintedShareCard {
  return paint('answer', question, query, null);
}

export function shareCardVisibleText(card: PaintedShareCard): string {
  return [
    card.alt,
    card.headline,
    card.flag ?? '',
    card.prices ?? '',
    card.footer.map((part) => part.text).join(''),
    card.chat.group,
    ...card.chat.lines.flatMap((line) => [line.name, line.text]),
    card.chat.delivered,
  ].join('\n');
}

export function shareCardImage(id: ShareCardId, query: ShareCardQuery = defaultShareQuery('en')) {
  const card = paintShareCard(id, query);
  return {
    url: shareCardUrl(id, query),
    ...SHARE_CARD_SIZE,
    alt: card.alt,
  };
}

export function answerShareImage(
  slug: string,
  question: string,
  query: ShareCardQuery = defaultShareQuery('en'),
) {
  return {
    url: answerShareUrl(slug, query),
    ...SHARE_CARD_SIZE,
    alt: paintAnswerCard(question, query).alt,
  };
}

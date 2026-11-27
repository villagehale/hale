import {
  BLACK_FRIDAY_PRICE_DISPLAY,
  PROMO_PRICE_DISPLAY,
  isBlackFridayWindowOpen,
  resolveBlackFridayNow,
} from '@hale/types';
import { languageTag } from '~/i18n/metadata';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL, SITE_URL } from '~/lib/app-url';
import { HALE_SAME_AS } from '~/lib/site/social';

/** Sale offers stay valid through the Dec 31 join date. */
export const SALE_PRICE_VALID_UNTIL = '2026-12-31';

/** Clock and review query for the offers. Production ignores `bf` and `bf_now`. */
export interface JsonLdSaleClock {
  now?: Date;
  env?: Record<string, string | undefined>;
  search?: Record<string, string | string[] | undefined>;
}

function queryValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? null;
}

/**
 * The same switch as the page: the holiday flag, then the one-day window.
 * Amounts stay in the display tables. A closed gate keeps the season prices.
 */
export function jsonLdBlackFriday(clock: JsonLdSaleClock = {}): boolean {
  const env = clock.env ?? process.env;
  if (env.HOLIDAY_PROMO_ENABLED !== 'true') return false;
  const now = resolveBlackFridayNow({
    now: clock.now ?? new Date(),
    env,
    bf: queryValue(clock.search?.bf),
    bfNow: queryValue(clock.search?.bf_now),
  });
  return isBlackFridayWindowOpen(now);
}

function saleAmount(plan: 'plus' | 'family', currency: 'CAD' | 'USD', oneDay: boolean): number {
  const table = oneDay ? BLACK_FRIDAY_PRICE_DISPLAY : PROMO_PRICE_DISPLAY;
  return table[plan][currency].amount;
}

/** Canada and the US, Plus and Max. Amounts come from the promo display tables. */
export function saleOffers(clock: JsonLdSaleClock = {}): Array<Record<string, string>> {
  const oneDay = jsonLdBlackFriday(clock);
  const rows = [
    ['Plus', 'CAD', saleAmount('plus', 'CAD', oneDay)],
    ['Max', 'CAD', saleAmount('family', 'CAD', oneDay)],
    ['Plus', 'USD', saleAmount('plus', 'USD', oneDay)],
    ['Max', 'USD', saleAmount('family', 'USD', oneDay)],
  ] as const;
  return rows.map(([name, priceCurrency, amount]) => ({
    '@type': 'Offer',
    name,
    price: String(amount),
    priceCurrency,
    priceValidUntil: SALE_PRICE_VALID_UNTIL,
    url: `${SITE_URL}/pricing`,
  }));
}

/**
 * The site-identity JSON-LD for the homepage: the three nodes an answer engine or
 * Google needs to treat Hale as a real, accountable entity rather than an anonymous
 * page — the Organization (who publishes), the WebSite (the canonical property), and
 * the SoftwareApplication (the product itself, with the Canada and US sale Offers).
 * Emitted as one `@graph` so a single script tag carries all three, cross-linked by
 * `@id`. Pure + exported so the shape is unit-tested against these constants rather
 * than eyeballed in the browser. The review query only moves the clock. No query
 * string is copied into the graph (hard rule #1). The descriptions and
 * `inLanguage` track the language the page is rendered in.
 */
export function siteJsonLd(
  locale: Locale = routing.defaultLocale,
  clock: JsonLdSaleClock = {},
): Record<string, unknown> {
  const t = getTranslator(locale, 'Jsonld');
  const inLanguage = languageTag(locale);

  // These descriptions are what an answer engine repeats back, so they have to say
  // what the homepage says — a graph that drifts from the page describes a product
  // no visitor sees.
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: 'Hale',
    legalName: 'Village Hale Technologies Inc.',
    url: SITE_URL,
    logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon.png` },
    description: t('orgDescription'),
    sameAs: HALE_SAME_AS,
  };

  const website = {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: SITE_URL,
    name: 'Hale',
    inLanguage,
    publisher: { '@id': `${SITE_URL}/#organization` },
  };

  const application = {
    '@type': 'SoftwareApplication',
    '@id': `${SITE_URL}/#app`,
    name: 'Hale',
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web, iOS',
    url: APP_URL,
    inLanguage,
    publisher: { '@id': `${SITE_URL}/#organization` },
    description: t('appDescription'),
    offers: saleOffers(clock),
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, application],
  };
}

/**
 * AboutPage JSON-LD for /about: the page, about the Organization, with its
 * founders and the countries Hale serves. Pure, no user input.
 */
/** /pricing JSON-LD. Same sale Offers as the homepage, in the page's language. */
export function pricingJsonLd(
  locale: Locale = routing.defaultLocale,
  clock: JsonLdSaleClock = {},
): Record<string, unknown> {
  const t = getTranslator(locale, 'Jsonld');
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Hale',
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web, iOS',
    url: `${SITE_URL}${prefix}/pricing`,
    inLanguage: languageTag(locale),
    description: t('appDescription'),
    offers: saleOffers(clock),
  };
}

export function aboutJsonLd(locale: Locale = routing.defaultLocale): Record<string, unknown> {
  const t = getTranslator(locale, 'Jsonld');
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    url: `${SITE_URL}${prefix}/about`,
    inLanguage: languageTag(locale),
    about: {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'Hale',
      legalName: 'Village Hale Technologies Inc.',
      url: SITE_URL,
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon.png` },
      description: t('orgDescription'),
      email: 'aloha@villagehale.com',
      sameAs: HALE_SAME_AS,
      foundingDate: '2026-06-24',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Georgetown',
        addressRegion: 'ON',
        addressCountry: 'CA',
      },
      areaServed: [
        { '@type': 'Country', name: 'United States' },
        { '@type': 'Country', name: 'Canada' },
      ],
      founder: [
        { '@type': 'Person', name: 'Barton Dong', jobTitle: 'CEO' },
        {
          '@type': 'Person',
          name: 'Eugene Song',
          jobTitle: 'CTO',
          sameAs: 'https://www.linkedin.com/in/yuhang-eugene-song-53b692172',
        },
      ],
    },
  };
}

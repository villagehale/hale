import { languageTag } from '~/i18n/metadata';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL, SITE_URL } from '~/lib/app-url';

/**
 * The site-identity JSON-LD for the homepage: the three nodes an answer engine or
 * Google needs to treat Hale as a real, accountable entity rather than an anonymous
 * page — the Organization (who publishes), the WebSite (the canonical property), and
 * the SoftwareApplication (the product itself, with its free tier and Canada scope).
 * Emitted as one `@graph` so a single script tag carries all three, cross-linked by
 * `@id`. Pure + exported so the shape is unit-tested against these constants rather
 * than eyeballed in the browser. No user input ever reaches it (hard rule #1). The
 * descriptions and `inLanguage` track the language the page is rendered in.
 */
export function siteJsonLd(locale: Locale = routing.defaultLocale): Record<string, unknown> {
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
    areaServed: { '@type': 'Country', name: 'Canada' },
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
    // Free to start — the launch tier. A concrete Offer node is the signal an answer
    // engine reads when a parent asks whether Hale costs anything.
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'CAD' },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, application],
  };
}

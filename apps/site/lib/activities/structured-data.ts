import { SITE_URL } from '~/lib/app-url';
import type { ActivityCity } from './index';

const PUBLISHER = { '@id': `${SITE_URL}/#organization` } as const;

/**
 * The JSON-LD graph for one city page: an Article (the editorial "how to find
 * activities in <city>" guidance), a BreadcrumbList (Activities → this city), and a
 * FAQPage (the city's questions). One `@graph`, cross-linked to the site
 * Organization/WebSite by `@id`. Pure + exported so the shape is unit-tested against
 * the city data rather than eyeballed.
 */
export function cityJsonLd(city: ActivityCity): Record<string, unknown> {
  const url = `${SITE_URL}/activities/${city.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: `Things to do with kids in ${city.city}`,
        description: city.intro,
        url,
        inLanguage: 'en-CA',
        isPartOf: { '@id': `${SITE_URL}/#website` },
        author: PUBLISHER,
        publisher: PUBLISHER,
        dateModified: city.updated,
        about: { '@type': 'City', name: city.city, address: { '@type': 'PostalAddress', addressRegion: city.provinceCode, addressCountry: 'CA' } },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Activities', item: `${SITE_URL}/activities` },
          { '@type': 'ListItem', position: 2, name: city.city, item: url },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        inLanguage: 'en-CA',
        mainEntity: city.faqs.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      },
    ],
  };
}

/**
 * The JSON-LD for the /activities hub: a CollectionPage listing the published city
 * guides as an ItemList. Pure + exported for unit testing.
 */
export function hubJsonLd(cities: readonly ActivityCity[]): Record<string, unknown> {
  const url = `${SITE_URL}/activities`;
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${url}#collection`,
    name: 'Things to do with kids, by city',
    url,
    inLanguage: 'en-CA',
    isPartOf: { '@id': `${SITE_URL}/#website` },
    publisher: PUBLISHER,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: cities.map((city, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: `Activities in ${city.city}`,
        item: `${SITE_URL}/activities/${city.slug}`,
      })),
    },
  };
}

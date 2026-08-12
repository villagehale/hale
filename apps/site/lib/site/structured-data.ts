import { APP_URL, SITE_URL } from '~/lib/app-url';
import { f14LandingEnabled } from '~/lib/flags/landing';

/**
 * The site-identity JSON-LD for the homepage: the three nodes an answer engine or
 * Google needs to treat Hale as a real, accountable entity rather than an anonymous
 * page — the Organization (who publishes), the WebSite (the canonical property), and
 * the SoftwareApplication (the product itself, with its free tier and Canada scope).
 * Emitted as one `@graph` so a single script tag carries all three, cross-linked by
 * `@id`. Pure + exported so the shape is unit-tested against these constants rather
 * than eyeballed in the browser. No user input ever reaches it (hard rule #1).
 */
export function siteJsonLd(): Record<string, unknown> {
  // Structured data follows the landing flag exactly like the page metadata does
  // (launch-day review P2, 2026-08-11): an answer engine must never describe a
  // homepage visitors don't see.
  const chief = f14LandingEnabled();
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: 'Hale',
    legalName: 'Village Hale Technologies Inc.',
    url: SITE_URL,
    logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon.png` },
    description: chief
      ? 'Hale is a family chief of staff you text — it watches city registration windows, plans the week, and handles the admin with your say-so. Every family’s data stays in Canada.'
      : 'Hale is a private, passive household assistant for families — it finds the classes, groups, and drop-ins near you worth a look, and keeps every family’s data in Canada.',
    areaServed: { '@type': 'Country', name: 'Canada' },
  };

  const website = {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: SITE_URL,
    name: 'Hale',
    inLanguage: 'en-CA',
    publisher: { '@id': `${SITE_URL}/#organization` },
  };

  const application = {
    '@type': 'SoftwareApplication',
    '@id': `${SITE_URL}/#app`,
    name: 'Hale',
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web, iOS',
    url: APP_URL,
    inLanguage: 'en-CA',
    publisher: { '@id': `${SITE_URL}/#organization` },
    description: chief
      ? 'A number your family texts: Hale watches registration dates across the GTA, plans the week, and executes with your approval — receipts for everything, and your family’s data never leaves Canada.'
      : 'A private, passive assistant for parents across every stage of childhood (0–18): it surfaces trusted local activities, quietly keeps track of what matters, and never sends your family’s data outside Canada.',
    // Free to start — the launch tier. A concrete Offer node is the signal an answer
    // engine reads when a parent asks whether Hale costs anything.
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'CAD' },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, application],
  };
}

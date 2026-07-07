import { SITE_URL } from '~/lib/app-url';
import { FRAMEWORK_SOURCES } from './frameworks';
import type { AnswerPage } from './types';

/**
 * The publishing entity behind every answer page. A grounded Organization node
 * (legal name, canonical URL, served logo) is the E-E-A-T publisher signal that
 * lets Google and the answer engines treat this YMYL health content as coming
 * from an identifiable, accountable source rather than an anonymous page.
 */
const PUBLISHER = {
  '@type': 'Organization',
  '@id': `${SITE_URL}/#organization`,
  name: 'Village Hale',
  legalName: 'Village Hale Technologies Inc.',
  url: SITE_URL,
  logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon.png` },
} as const;

/**
 * The JSON-LD graph for an answer page: a MedicalWebPage/Article (with its
 * grounded citations and the health authorities it was reviewed against) and a
 * FAQPage (the related questions). Emitted as a single `@graph` so both types
 * share one script tag. Pure + exported so the shape is unit-tested against the
 * page data rather than eyeballed in the browser.
 */
export function answerJsonLd(page: AnswerPage): Record<string, unknown> {
  const url = `${SITE_URL}/answers/${page.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        // MedicalWebPage typing tells the answer engines this is health content
        // held to a higher trust bar; Article keeps it readable as editorial.
        '@type': ['MedicalWebPage', 'Article'],
        '@id': `${url}#article`,
        headline: page.title,
        description: page.description,
        mainEntityOfPage: url,
        dateModified: page.updated,
        inLanguage: 'en-CA',
        author: PUBLISHER,
        publisher: PUBLISHER,
        // The health authorities this page's claims are checked against — the
        // genuine expertise signal, distinct from the framework `citation`s.
        reviewedBy: page.citations.map((c) => ({
          '@type': 'Organization',
          name: FRAMEWORK_SOURCES[c.framework].label,
          url: FRAMEWORK_SOURCES[c.framework].home,
        })),
        citation: page.citations.map((c) => ({
          '@type': 'CreativeWork',
          name: FRAMEWORK_SOURCES[c.framework].label,
          url: FRAMEWORK_SOURCES[c.framework].home,
        })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: [
          {
            '@type': 'Question',
            name: page.question,
            acceptedAnswer: { '@type': 'Answer', text: page.answer },
          },
          ...page.faqs.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        ],
      },
    ],
  };
}

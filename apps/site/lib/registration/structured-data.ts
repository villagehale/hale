import { SITE_URL } from '~/lib/app-url';
import type { RegistrationGuide } from './types';

const PUBLISHER = { '@id': `${SITE_URL}/#organization` } as const;

/**
 * JSON-LD for a city-registration landing page: an Article (the dates and the
 * rule that makes parents miss) plus a FAQPage of the questions parents type.
 * Not MedicalWebPage — these are municipal calendars, not parenting-health copy.
 */
export function registrationJsonLd(guide: RegistrationGuide): Record<string, unknown> {
  const url = `${SITE_URL}${guide.path}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: guide.h1.map((s) => s.text).join(' '),
        description: guide.description,
        url,
        inLanguage: 'en-CA',
        isPartOf: { '@id': `${SITE_URL}/#website` },
        author: PUBLISHER,
        publisher: PUBLISHER,
        dateModified: guide.updated,
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        inLanguage: 'en-CA',
        mainEntity: guide.faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer },
        })),
      },
    ],
  };
}

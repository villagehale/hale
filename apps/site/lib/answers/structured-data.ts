import { SITE_URL } from '~/lib/app-url';
import { FRAMEWORK_SOURCES } from './frameworks';
import type { AnswerPage } from './types';

/**
 * The JSON-LD graph for an answer page: an Article (with its grounded citations)
 * and a FAQPage (the related questions). Emitted as a single `@graph` so both
 * types share one script tag. Pure + exported so the shape is unit-tested against
 * the page data rather than eyeballed in the browser.
 */
export function answerJsonLd(page: AnswerPage): Record<string, unknown> {
  const url = `${SITE_URL}/answers/${page.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: page.title,
        description: page.description,
        mainEntityOfPage: url,
        dateModified: page.updated,
        inLanguage: 'en-CA',
        author: { '@type': 'Organization', name: 'Hale' },
        publisher: { '@type': 'Organization', name: 'Hale' },
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

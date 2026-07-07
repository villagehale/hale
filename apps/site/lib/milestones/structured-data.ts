import { SITE_URL } from '~/lib/app-url';
import type { MilestoneCheckpoint } from './types';

/**
 * The JSON-LD graph for one age checkpoint: a MedicalWebPage (also typed as an
 * Article so it reads as editorial content) plus a BreadcrumbList (Milestones →
 * this age). Pure + exported so the shape is unit-tested against the data rather
 * than eyeballed in the browser.
 */
export function checkpointJsonLd(checkpoint: MilestoneCheckpoint): Record<string, unknown> {
  const url = `${SITE_URL}/milestones/${checkpoint.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['MedicalWebPage', 'Article'],
        '@id': `${url}#article`,
        headline: checkpoint.title,
        description: checkpoint.description,
        mainEntityOfPage: url,
        dateModified: checkpoint.updated,
        inLanguage: 'en-CA',
        author: { '@type': 'Organization', name: 'Hale' },
        publisher: { '@type': 'Organization', name: 'Hale' },
        citation: [
          {
            '@type': 'CreativeWork',
            name: 'CDC — Learn the Signs. Act Early.',
            url: checkpoint.sourceUrl,
          },
        ],
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Milestones',
            item: `${SITE_URL}/milestones`,
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: `Around ${checkpoint.ageLabel}`,
            item: url,
          },
        ],
      },
    ],
  };
}

/**
 * The JSON-LD for the hub: an ItemList of the published age checkpoints, in age
 * order. Emitted only when at least one checkpoint is published (an empty list
 * would be noise).
 */
export function hubJsonLd(checkpoints: MilestoneCheckpoint[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: "Child development milestones by age — what's typical",
    itemListElement: checkpoints.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `Around ${c.ageLabel}`,
      url: `${SITE_URL}/milestones/${c.slug}`,
    })),
  };
}

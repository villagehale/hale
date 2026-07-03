import type { MetadataRoute } from 'next';
import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';

// Static marketing routes. Add new public pages here as they ship.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes: MetadataRoute.Sitemap = ['', '/about', '/contact'].map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency: 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));

  // Answer pages enter the sitemap only once a human reviews them and flips
  // `published` — the review-before-index gate. Drafts are excluded here and
  // noindexed on the page itself. The /answers index rides in with them.
  const answerRoutes: MetadataRoute.Sitemap =
    publishedAnswers.length === 0
      ? []
      : [
          {
            url: `${SITE_URL}/answers`,
            lastModified,
            changeFrequency: 'weekly',
            priority: 0.6,
          },
          ...publishedAnswers.map((page) => ({
            url: `${SITE_URL}/answers/${page.slug}`,
            lastModified: new Date(page.updated),
            changeFrequency: 'weekly' as const,
            priority: 0.6,
          })),
        ];

  return [...staticRoutes, ...answerRoutes];
}

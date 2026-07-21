import type { MetadataRoute } from 'next';
import { publishedCities } from '~/lib/activities/index';
import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';
import { publishedCheckpoints } from '~/lib/milestones/index';

// Static marketing routes. Add new public pages here as they ship.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes: MetadataRoute.Sitemap = ['', '/about', '/contact', '/faq', '/pricing'].map((path) => ({
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

  // Milestone age pages ride the same review-before-index gate: excluded until a
  // human re-verifies an age's copy against its cited CDC URL and flips
  // `published`. The /milestones hub enters with them.
  const milestoneRoutes: MetadataRoute.Sitemap =
    publishedCheckpoints.length === 0
      ? []
      : [
          {
            url: `${SITE_URL}/milestones`,
            lastModified,
            changeFrequency: 'monthly',
            priority: 0.6,
          },
          ...publishedCheckpoints.map((checkpoint) => ({
            url: `${SITE_URL}/milestones/${checkpoint.slug}`,
            lastModified: new Date(checkpoint.updated),
            changeFrequency: 'monthly' as const,
            priority: 0.6,
          })),
        ];

  // City activity guides ride the same review-before-index gate: excluded until a
  // human verifies a city's provincial-program details and flips `published`. The
  // /activities hub enters with them.
  const activityRoutes: MetadataRoute.Sitemap =
    publishedCities.length === 0
      ? []
      : [
          {
            url: `${SITE_URL}/activities`,
            lastModified,
            changeFrequency: 'monthly',
            priority: 0.6,
          },
          ...publishedCities.map((city) => ({
            url: `${SITE_URL}/activities/${city.slug}`,
            lastModified: new Date(city.updated),
            changeFrequency: 'monthly' as const,
            priority: 0.6,
          })),
        ];

  return [...staticRoutes, ...answerRoutes, ...milestoneRoutes, ...activityRoutes];
}

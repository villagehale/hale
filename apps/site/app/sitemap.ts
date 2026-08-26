import type { MetadataRoute } from 'next';
import { publishedCities } from '~/lib/activities/index';
import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';
import { REGISTRATION_GUIDES } from '~/lib/registration/index';

// Static marketing routes. Add new public pages here as they ship.
// /milestones is NOT here: it is retired (permanent redirect to /), and a retired
// route must never be advertised for indexing.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes: MetadataRoute.Sitemap = ['', '/about', '/contact', '/faq', '/pricing'].map(
    (path) => ({
      url: `${SITE_URL}${path}`,
      lastModified,
      changeFrequency: 'monthly',
      priority: path === '' ? 1 : 0.7,
    }),
  );

  // City-registration landings are English-first municipal calendars. They rot in
  // about six weeks, so they carry weekly change frequency and their own
  // dateModified rather than the sitemap-build clock.
  const registrationRoutes: MetadataRoute.Sitemap = REGISTRATION_GUIDES.map((guide) => ({
    url: `${SITE_URL}${guide.path}`,
    lastModified: new Date(guide.updated),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
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

  return [...staticRoutes, ...registrationRoutes, ...answerRoutes, ...activityRoutes];
}

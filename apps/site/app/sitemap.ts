import type { MetadataRoute } from 'next';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';

// Static marketing routes. Add new public pages here as they ship.
// /milestones is NOT here: it is retired (permanent redirect to /), and a retired
// route must never be advertised for indexing.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes = ['', '/about', '/contact', '/faq', '/pricing'].flatMap((path) =>
    localized(path, lastModified, 'monthly', path === '' ? 1 : 0.7),
  );

  // Answer pages enter the sitemap only once a human reviews them and flips
  // `published` — the review-before-index gate. Drafts are excluded here and
  // noindexed on the page itself. The /answers index rides in with them.
  const answerRoutes: MetadataRoute.Sitemap =
    publishedAnswers.length === 0
      ? []
      : [
          ...localized('/answers', lastModified, 'weekly', 0.6),
          ...publishedAnswers.flatMap((page) =>
            localized(`/answers/${page.slug}`, new Date(page.updated), 'weekly', 0.6),
          ),
        ];

  // The activities hub stays. The per-city guides are retired (308 to this URL),
  // so they are not advertised for indexing.
  const activityRoutes = localized('/activities', lastModified, 'monthly', 0.6);

  return [...staticRoutes, ...answerRoutes, ...activityRoutes];
}

function absolute(locale: Locale, path: string): string {
  const href = localeHref(locale, path === '' ? '/' : path);
  return href === '/' ? SITE_URL : `${SITE_URL}${href}`;
}

function languages(path: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of routing.locales) languages[locale] = absolute(locale, path);
  languages['x-default'] = absolute(routing.defaultLocale, path);
  return languages;
}

function localized(
  path: string,
  lastModified: Date,
  changeFrequency: 'weekly' | 'monthly',
  priority: number,
): MetadataRoute.Sitemap {
  return routing.locales.map((locale) => ({
    url: absolute(locale, path),
    lastModified,
    changeFrequency,
    priority,
    alternates: { languages: languages(path) },
  }));
}

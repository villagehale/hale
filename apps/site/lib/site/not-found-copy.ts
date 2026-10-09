import type { Metadata } from 'next';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';

const HALE_SUFFIX = ' · Hale';

/** The middleware sets this on every page request (next-intl HEADER_LOCALE_NAME). */
export const LOCALE_HEADER = 'x-next-intl-locale';

export function localeFromHeader(value: string | null): Locale {
  if (value === 'fr' || value === 'zh' || value === 'en') return value;
  return routing.defaultLocale;
}

/** Full tab title, including the Hale suffix. The site has no title template. */
export function notFoundTitle(locale: Locale): string {
  return getTranslator(locale, 'Common')('notFoundTitle');
}

/** The visible heading: the tab title without the " · Hale" suffix. */
export function notFoundHeading(locale: Locale): string {
  const title = notFoundTitle(locale);
  return title.endsWith(HALE_SUFFIX) ? title.slice(0, -HALE_SUFFIX.length) : title;
}

export function notFoundMetadata(locale: Locale): Metadata {
  const title = notFoundTitle(locale);
  // openGraph and twitter replace the parent objects; they are not deep-merged.
  // A title-only export would leave the homepage preview on the 404.
  return {
    title,
    openGraph: { title },
    twitter: { title },
  };
}

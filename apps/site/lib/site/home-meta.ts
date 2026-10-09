import type { Metadata } from 'next';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { SITE_URL } from '~/lib/app-url';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';

/**
 * The homepage's positioning (D21): link previews and search snippets must
 * describe the page a visitor actually lands on, in the language they land in.
 * Title, og:title, and twitter:title are the same string. There is no title
 * template — a template would suffix every page that already ends in "· Hale".
 */
export function homeMetadata(locale: Locale): Metadata {
  const t = getTranslator(locale, 'HomeMeta');
  // The town count is a derived number, never a hand-written one: a 22nd
  // municipality must not leave the search snippet claiming 21 (municipalities.ts
  // derives it from the list for the same reason the page does).
  const counted = { count: MUNICIPALITY_COUNT };
  return {
    metadataBase: new URL(SITE_URL),
    title: t('title'),
    description: t('description', counted),
    alternates: buildAlternates(locale, '/'),
    openGraph: {
      type: 'website',
      siteName: 'Hale',
      url: localeHref(locale, '/'),
      title: t('title'),
      description: t('ogDescription', counted),
      locale: ogLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      title: t('title'),
      description: t('twitterDescription'),
    },
  };
}

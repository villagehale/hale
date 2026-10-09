import type { Metadata } from 'next';
import { localeHref } from './navigation';
import { type Locale, routing } from './routing';

/**
 * Per-page hreflang alternates for `generateMetadata`. Emits one `<link
 * rel="alternate" hreflang>` per locale plus `x-default`, and the canonical for
 * the locale being rendered. Paths are locale-relative (no prefix); Next resolves
 * them against `metadataBase`.
 */
export function buildAlternates(locale: Locale, path: string): NonNullable<Metadata['alternates']> {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    languages[l] = localeHref(l, path);
  }
  languages['x-default'] = localeHref(routing.defaultLocale, path);

  return {
    canonical: localeHref(locale, path),
    languages,
  };
}

/**
 * Link-preview titles for a page that would otherwise inherit the homepage's.
 * Same shape pricing, FAQ, and activities already emit. A title template is
 * deliberately not used: every metaTitle is already a full "… · Hale" string.
 */
export function socialMetadata(
  locale: Locale,
  path: string,
  title: string,
  description: string,
): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: {
      type: 'website',
      title,
      description,
      url: localeHref(locale, path),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/** The Open Graph `locale` tag for each language (Canada-first). */
export function ogLocale(locale: Locale): string {
  return { en: 'en_CA', fr: 'fr_CA', zh: 'zh_CN' }[locale];
}

/** The BCP-47 language tag for `inLanguage` / `hreflang` fields (Canada-first). */
export function languageTag(locale: Locale): string {
  return { en: 'en-CA', fr: 'fr-CA', zh: 'zh-Hans' }[locale];
}

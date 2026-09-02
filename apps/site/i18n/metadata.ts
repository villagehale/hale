import type { Metadata } from 'next';
import { type Locale, routing } from './routing';
import { localeHref } from './navigation';

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

/** The Open Graph `locale` tag for each language (Canada-first). */
export function ogLocale(locale: Locale): string {
  return { en: 'en_CA', fr: 'fr_CA', zh: 'zh_CN' }[locale];
}

/** The BCP-47 language tag for `inLanguage` / `hreflang` fields (Canada-first). */
export function languageTag(locale: Locale): string {
  return { en: 'en-CA', fr: 'fr-CA', zh: 'zh-Hans' }[locale];
}

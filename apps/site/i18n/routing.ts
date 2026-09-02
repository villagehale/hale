import { defineRouting } from 'next-intl/routing';

/**
 * The marketing site speaks three languages: English (default, unprefixed),
 * Canadian French, and Simplified Chinese. `as-needed` keeps every English URL
 * exactly where it was — `/`, `/about`, `/pricing` — while French lives under
 * `/fr` and Chinese under `/zh`.
 *
 * The URL is the single source of truth for language: no locale cookie, and no
 * Accept-Language redirect off `/`. A shared link always opens in the language it
 * was written in, `/` is always English, and the footer selector is the only way
 * a visitor changes language.
 */
export const routing = defineRouting({
  locales: ['en', 'fr', 'zh'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeCookie: false,
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];

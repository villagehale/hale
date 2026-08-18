import { type Locale, routing } from './routing';

/**
 * Locale-aware internal links, built provider-free so Server Components can call
 * them directly. With `as-needed`, the default locale keeps the bare path
 * (`/pricing`) and the others carry a prefix (`/fr/pricing`). Every internal
 * `href` on a localized page MUST go through this, or a link on `/fr/about` would
 * silently drop the reader back into English.
 *
 * `sms:`, `mailto:`, and absolute app URLs are left to callers untouched.
 */
export function localeHref(locale: Locale, path: string): string {
  if (locale === routing.defaultLocale) return path;
  if (path === '/') return `/${locale}`;
  return `/${locale}${path}`;
}

/** Strip a leading locale segment from a pathname, yielding the bare path the
 * footer selector re-prefixes for the target language. `/fr/about` → `/about`,
 * `/fr` → `/`, `/about` → `/about`. */
export function stripLocalePrefix(pathname: string): string {
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue;
    if (pathname === `/${locale}`) return '/';
    if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1);
  }
  return pathname;
}

/** The languages the footer selector offers, each named in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  zh: '简体中文',
};

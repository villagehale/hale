/**
 * The four dated city registration guides, retired to the activities hub.
 *
 * These used to be route handlers (`permanentRedirect` in each page). The
 * handlers are gone with the pages. The forward lives in next.config instead —
 * `permanent: true` is a 308 — so an old link or a search result still lands,
 * and the request query string is kept. Next appends that query only when the
 * destination has none of its own.
 *
 * Locales match `i18n/routing.ts`: English is unprefixed, French is `/fr`,
 * Chinese is `/zh`. Each path is listed with and without a trailing slash.
 * `trailingSlash` stays off, so Next's own `/:path+/` → `/:path+` 308 also
 * folds a slashed URL onto the bare one before these rules; the slash source
 * is the same forward if that hop is skipped.
 */

export const RETIRED_REGISTRATION_GUIDES = [
  'toronto-fall-recreation-registration',
  'toronto-swim-registration',
  'brampton-swim-registration',
  'ymca-gta-swim-registration',
] as const;

/** Non-default locale prefixes. English stays unprefixed (`localePrefix: as-needed`). */
export const RETIRED_REGISTRATION_LOCALE_PREFIXES = ['fr', 'zh'] as const;

export interface RetiredRegistrationRedirect {
  source: string;
  destination: string;
  permanent: true;
}

export function retiredRegistrationRedirects(): RetiredRegistrationRedirect[] {
  const rules: RetiredRegistrationRedirect[] = [];
  for (const slug of RETIRED_REGISTRATION_GUIDES) {
    const variants: Array<{ source: string; destination: string }> = [
      { source: `/${slug}`, destination: '/activities' },
      { source: `/${slug}/`, destination: '/activities' },
    ];
    for (const locale of RETIRED_REGISTRATION_LOCALE_PREFIXES) {
      variants.push(
        { source: `/${locale}/${slug}`, destination: `/${locale}/activities` },
        { source: `/${locale}/${slug}/`, destination: `/${locale}/activities` },
      );
    }
    for (const variant of variants) {
      rules.push({ ...variant, permanent: true });
    }
  }
  return rules;
}

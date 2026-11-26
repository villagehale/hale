import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import {
  CONSENT_GEO_HEADER,
  consentGeoOverrideActive,
  parseConsentGeoOverride,
} from './lib/site/consent-region';
import { SHARE_SEARCH_HEADER } from './lib/site/share-search-header';

const handleI18n = createMiddleware(routing);

/**
 * `not-found.tsx` is collected with the layout, so Next never gives it
 * `searchParams`. A `?promo_phase=` review link still has to reach that card.
 * next-intl already forwards request headers on its rewrite; this appends the
 * raw query to that list. A request with no `promo_phase` and no preview
 * `consent_geo` is not stamped, so its locale redirects and next-intl headers
 * stay exactly as next-intl set them.
 */
export function stampRequestHeader(response: Response, name: string, value: string): void {
  const listed = response.headers.get('x-middleware-override-headers');
  // A partial override list would drop every header that is not named.
  if (listed === null) return;
  const names = listed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.includes(name)) {
    names.push(name);
    response.headers.set('x-middleware-override-headers', names.join(','));
  }
  response.headers.set(`x-middleware-request-${name}`, value);
}

export function stampShareSearch(response: Response, search: string): void {
  stampRequestHeader(response, SHARE_SEARCH_HEADER, search);
}

export default function middleware(request: NextRequest) {
  const response = handleI18n(request);
  if (request.nextUrl.searchParams.has('promo_phase')) {
    stampShareSearch(response, request.nextUrl.search);
  }
  // Preview and local only. Production ignores the query even if it is present.
  if (consentGeoOverrideActive()) {
    const raw = request.nextUrl.searchParams.get('consent_geo');
    if (raw && parseConsentGeoOverride(raw)) {
      stampRequestHeader(response, CONSENT_GEO_HEADER, raw.trim());
    }
  }
  return response;
}

export const config = {
  // Run i18n routing on page paths only. Everything with a dot (llms.txt,
  // robots.txt, sitemap.xml, favicon.ico, fonts, images) and the framework
  // internals are excluded, so those keep serving unprefixed and untouched.
  matcher: '/((?!api|ingest|og|_next|_vercel|llms\\.txt|.*\\..*).*)',
};

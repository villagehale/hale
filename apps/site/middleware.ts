import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { SHARE_SEARCH_HEADER } from './lib/site/share-search-header';

const handleI18n = createMiddleware(routing);

/**
 * `not-found.tsx` is collected with the layout, so Next never gives it
 * `searchParams`. The sale phase still has to follow `?promo_phase=`, and the
 * middleware already forwards the request headers on the rewrite.
 */
export function stampShareSearch(response: Response, search: string): void {
  const listed = response.headers.get('x-middleware-override-headers');
  // A partial override list would drop every header that is not named.
  if (listed === null) return;
  const names = listed
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.includes(SHARE_SEARCH_HEADER)) {
    names.push(SHARE_SEARCH_HEADER);
    response.headers.set('x-middleware-override-headers', names.join(','));
  }
  response.headers.set(`x-middleware-request-${SHARE_SEARCH_HEADER}`, search);
}

export default function middleware(request: NextRequest) {
  const response = handleI18n(request);
  stampShareSearch(response, request.nextUrl.search);
  return response;
}

export const config = {
  // Run i18n routing on page paths only. Everything with a dot (llms.txt,
  // robots.txt, sitemap.xml, favicon.ico, fonts, images) and the framework
  // internals are excluded, so those keep serving unprefixed and untouched.
  matcher: '/((?!api|ingest|og|_next|_vercel|llms\\.txt|.*\\..*).*)',
};

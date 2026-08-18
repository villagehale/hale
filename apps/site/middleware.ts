import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Run i18n routing on page paths only. Everything with a dot (llms.txt,
  // robots.txt, sitemap.xml, favicon.ico, fonts, images) and the framework
  // internals are excluded, so those keep serving unprefixed and untouched.
  matcher: '/((?!api|_next|_vercel|llms\\.txt|.*\\..*).*)',
};

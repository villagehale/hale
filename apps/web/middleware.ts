import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '~/auth.config';
import { authConfigured } from '~/lib/auth-config';
import { bridgeBearerToSessionCookie } from '~/lib/auth/bearer-bridge';
import { isProtectedPath } from '~/lib/auth/protected-routes';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { RETIRED_TARGET, isRetiredPath } from '~/lib/routes/retired';

// The middleware runs on the Edge runtime, so it builds `auth` from the Edge-safe
// base config (Google + identity callbacks) — NOT from ~/auth, whose Credentials
// authorize pulls in Node-only deps (argon2, node:crypto, the Postgres client)
// the Edge bundle can't load. Credentials sign-in runs in the Node API route,
// never here; the middleware only reads the already-signed session JWT.
const { auth } = NextAuth(authConfig);

// auth() wraps the middleware so req.auth carries the Auth.js session. An
// unauthenticated request to a protected route is redirected to /sign-in.
//
// Dev-preview parity with the old clerkConfigured()===false path: when Google
// isn't configured we leave the route group UNPROTECTED so local screenshots
// work — but ONLY outside production. In production an unconfigured provider
// fails CLOSED (redirect to /sign-in) so a misconfiguration can never expose a
// protected route to an unauthenticated request (rule #1).
export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Mobile Bearer bridge (runs before any page logic): for an /api/* request that
  // carries `Authorization: Bearer <token>` and no existing session cookie, append
  // the Auth.js session cookie to the REQUEST headers so every downstream
  // `await auth()` in the route sees a session — mobile authenticates through the
  // unchanged web path. `secure` is read the SAME way the token was minted
  // (`x-forwarded-proto`, first hop) so the cookie name matches the JWT salt. An
  // /api request never falls into a page branch below (no /api prefix is protected
  // and it isn't /onboarding), so a bridged request's only outcome is pass-through
  // with the rewritten headers; an unbridged/invalid one ends as the route's own
  // 401, not a /sign-in redirect. Browser requests (no Authorization header) get
  // null here and take the byte-identical pre-existing path.
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const bridged = bridgeBearerToSessionCookie({
    headers: req.headers,
    pathname,
    secure: proto === 'https',
  });
  if (bridged) {
    const headers = new Headers(req.headers);
    headers.set('cookie', bridged.cookieHeader);
    return NextResponse.next({ request: { headers } });
  }

  // (The beta invite gate stood here. It gated exactly one path — /onboarding — and
  // that route is deleted (F14), so the gate had nothing left to admit anyone to.
  // BETA_INVITE_ONLY / BETA_INVITE_CODE are now read by nothing.)

  // Retired surfaces (receipts-room slimdown) answer with a real 308 before anything
  // else. Ahead of the auth gate on purpose: a route that no longer exists should not
  // cost a session lookup or a DB round trip to say so, and a signed-out visitor
  // holding an old link deserves the same honest answer as a signed-in one. See
  // lib/routes/retired.ts for why this cannot live in the page alone.
  if (isRetiredPath(pathname)) {
    return NextResponse.redirect(new URL(RETIRED_TARGET, req.nextUrl), 308);
  }

  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  // VIL-244 · M9 (D4/D20): under the receipts-room IA the daily feed is DEMOTED and the
  // week view is the landing surface. The forward lives HERE rather than in the page,
  // because a page-level `redirect()` under a streaming `force-dynamic` layout resolves
  // as a mid-stream client navigation (200 + a soft push), not a redirect the browser
  // or a link-checker can see. The route itself is untouched — deleting it is a later PR.
  if (receiptsIaEnabled() && (pathname === '/home' || pathname.startsWith('/home/'))) {
    return NextResponse.redirect(new URL('/plan', req.nextUrl), 302);
  }

  if (!authConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.redirect(new URL('/sign-in', req.nextUrl));
    }
    return NextResponse.next();
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL('/sign-in', req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};

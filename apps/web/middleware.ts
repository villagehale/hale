import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '~/auth.config';
import { authConfigured } from '~/lib/auth-config';
import { isProtectedPath } from '~/lib/auth/protected-routes';
import { RETURN_PATH_HEADER, signInHref } from '~/lib/auth/redirect';
import { PASSPORT_DEMO_HEADER, passportDemoBypassesAuth } from '~/lib/passport/demo';
import { RETIRED_TARGET, isRetiredPath } from '~/lib/routes/retired';
import { isRetiredAuthPath, retiredAuthRedirectUrl } from '~/lib/routes/retired-auth';

// The middleware runs on the Edge runtime, so it builds `auth` from the Edge-safe
// base config (identity callbacks, no providers) — NOT from ~/auth, whose phone and
// connect authorize pull in Node-only deps (node:crypto, the Postgres client)
// the Edge bundle can't load. Those sign-ins run in the Node API route, never
// here; the middleware only reads the already-signed session JWT.
const { auth } = NextAuth(authConfig);

// auth() wraps the middleware so req.auth carries the Auth.js session. An
// unauthenticated request to a protected route is redirected to /sign-in.
//
// Dev-preview parity with the old clerkConfigured()===false path: when
// AUTH_SECRET isn't set we leave the route group UNPROTECTED so local
// screenshots work — but ONLY outside production. In production an unconfigured
// secret fails CLOSED (redirect to /sign-in) so a misconfiguration can never
// expose a protected route to an unauthenticated request (rule #1).
export default auth((req) => {
  const { pathname } = req.nextUrl;

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

  // Retired email doors (password, magic link, email verify, the email invite
  // landing). Same reason this cannot live in the page alone. The target is
  // bare /sign-in — retiredAuthRedirectUrl drops any token or query.
  if (isRetiredAuthPath(pathname)) {
    return NextResponse.redirect(retiredAuthRedirectUrl(req.nextUrl), 308);
  }

  if (!isProtectedPath(pathname)) {
    // API routes stay a plain next() — nothing here is a page deep link, and
    // the cookie-auth tests assert those requests are not header-rewritten.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return NextResponse.next();
    }
    return stampReturnPath(req);
  }

  // The receipts portal's landing IS /home. /family is the editor, so
  // /family/members has nothing of its own left to show. A real 308, for the
  // streaming-layout reason; the page also permanentRedirects (defense in depth).
  if (pathname === '/family/members' || pathname.startsWith('/family/members/')) {
    return NextResponse.redirect(new URL('/family', req.nextUrl), 308);
  }

  if (!authConfigured()) {
    if (process.env.NODE_ENV === 'production' && !passportDemoBypassesAuth(pathname)) {
      return redirectToSignIn(req);
    }
    return nextWithHeaders(req, pathname);
  }

  if (!req.auth) {
    if (!passportDemoBypassesAuth(pathname)) {
      return redirectToSignIn(req);
    }
  }

  return nextWithHeaders(req, pathname);
});

/** Signed-out gate: /sign-in?callbackUrl=<path+query>, or bare /sign-in when the path is unsafe. */
function redirectToSignIn(req: { nextUrl: URL }) {
  const returnTo = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  return NextResponse.redirect(new URL(signInHref(returnTo), req.nextUrl));
}

function stampReturnPath(req: { headers: Headers; nextUrl: URL }) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(RETURN_PATH_HEADER, `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Forwards the request with the passport-demo header rewritten.
 * A client-sent copy is removed first. The passport demo header is set only
 * for the fixture family routes, and only when the preview demo is on —
 * production never reaches that branch. The return-path header is overwritten
 * here too, so a client cannot supply the value the layout reads.
 */
function nextWithHeaders(req: { headers: Headers; nextUrl: URL }, pathname: string) {
  const requestHeaders = new Headers(req.headers);
  // Overwrite any client-sent copy. The layout trusts this header for the
  // signed-out return path, so only the middleware may write it.
  requestHeaders.set(RETURN_PATH_HEADER, `${req.nextUrl.pathname}${req.nextUrl.search}`);
  requestHeaders.delete(PASSPORT_DEMO_HEADER);
  if (passportDemoBypassesAuth(pathname)) {
    requestHeaders.set(PASSPORT_DEMO_HEADER, '1');
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};

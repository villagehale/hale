import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '~/auth.config';
import { authConfigured } from '~/lib/auth-config';
import { ADMIN_PROBE_HEADER, isAdminPath, isProtectedPath } from '~/lib/auth/protected-routes';
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

  // The receipts portal's landing IS /home (the parent home). It used to 302 to
  // /family under F14_RECEIPTS_IA; that forward is gone so the home page can render.
  // Flag-off /home is still the daily feed — the page branches, the URL does not.

  // Under the same reframe the family EDITOR moved up a level: /family is the editor
  // now, so /family/members has nothing of its own left to show. A real 308 beside the
  // /home hinge, for the same streaming-layout reason; the page also permanentRedirects
  // (defense in depth, the retired-routes pattern). Flag-conditional so the flag-off IA
  // keeps its hub → editor split untouched.
  if (
    receiptsIaEnabled() &&
    (pathname === '/family/members' || pathname.startsWith('/family/members/'))
  ) {
    return NextResponse.redirect(new URL('/family', req.nextUrl), 308);
  }

  // The founder portal answers a session-less probe with a 404, NEVER the
  // sign-in redirect the rest of the gated app uses — a redirect would advertise
  // that /admin exists. The rewrite target matches no route, so Next renders the
  // not-found page with a real 404 status; an authed non-admin gets the same 404
  // from the nested (authed)/admin layout itself.
  if (isAdminPath(pathname) && (!authConfigured() || !req.auth)) {
    return NextResponse.rewrite(new URL('/admin/__denied__/404', req.nextUrl));
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

  // The authed /admin probe: mark the request so the (authed) layout — which
  // sits ABOVE the group's loading.tsx Suspense boundary — can 404 a signed-in
  // non-admin BEFORE the streaming shell flushes a 200. Every other request has
  // any client-sent copy STRIPPED, so only the middleware can speak this header.
  const requestHeaders = new Headers(req.headers);
  if (isAdminPath(pathname)) {
    requestHeaders.set(ADMIN_PROBE_HEADER, '1');
  } else {
    requestHeaders.delete(ADMIN_PROBE_HEADER);
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
});

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};

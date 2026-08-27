import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '~/auth.config';
import { authConfigured } from '~/lib/auth-config';
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
  // landing surface is APPROVALS — the receipts room itself. It used to forward to the
  // week view, but #455 demoted `/plan` out of the nav too, so the landing was a surface
  // the sidebar no longer lists: reachable, but incoherent as the first thing a parent
  // sees. Approvals is the one stop that is both the nav's first entry and the room the
  // whole IA is named for. The forward lives HERE rather than in the page, because a
  // page-level `redirect()` under a streaming `force-dynamic` layout resolves as a
  // mid-stream client navigation (200 + a soft push), not a redirect the browser or a
  // link-checker can see. The route itself is untouched — deleting it is a later PR.
  //
  // Every post-auth target elsewhere stays `/home` on purpose: this line is the single
  // flag-conditional hinge, so with the flag OFF `/home` remains the real daily feed and
  // the real landing. Retargeting those call sites would break the flag-off path.
  if (receiptsIaEnabled() && (pathname === '/home' || pathname.startsWith('/home/'))) {
    return NextResponse.redirect(new URL('/approvals', req.nextUrl), 302);
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

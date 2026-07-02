import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '~/auth.config';
import { authConfigured } from '~/lib/auth-config';
import { bridgeBearerToSessionCookie } from '~/lib/auth/bearer-bridge';
import { inviteGateDecision } from '~/lib/onboarding/invite-gate';

// The middleware runs on the Edge runtime, so it builds `auth` from the Edge-safe
// base config (Google + identity callbacks) — NOT from ~/auth, whose Credentials
// authorize pulls in Node-only deps (argon2, node:crypto, the Postgres client)
// the Edge bundle can't load. Credentials sign-in runs in the Node API route,
// never here; the middleware only reads the already-signed session JWT.
const { auth } = NextAuth(authConfig);

const INVITE_COOKIE = 'hale_invite';
const MARKETING_FALLBACK = 'https://villagehale.com';

// Paths rendered by the (authed) route group. The group name isn't part of the
// URL, so the matcher can't target it directly — we gate these prefixes by hand.
const PROTECTED_PREFIXES = [
  '/coach',
  '/companion',
  '/family',
  '/home',
  '/plan',
  '/settings',
  '/trail',
  '/village',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

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

  // Beta invite gate (closed-beta only; flip BETA_INVITE_ONLY=false at launch).
  // Lives here, not in the page, because Server Components can't set cookies.
  // No DB — the gate is a shared code; the per-user provisioning check is in the
  // (authed) layout, which can query the database.
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
    const decision = inviteGateDecision({
      inviteOnly: process.env.BETA_INVITE_ONLY !== 'false',
      code: process.env.BETA_INVITE_CODE,
      param: req.nextUrl.searchParams.get('invite'),
      cookie: req.cookies.get(INVITE_COOKIE)?.value,
    });
    if (decision.kind === 'deny') {
      return NextResponse.redirect(
        new URL(process.env.NEXT_PUBLIC_MARKETING_URL ?? MARKETING_FALLBACK),
      );
    }
    if (decision.kind === 'grant') {
      const res = NextResponse.next();
      res.cookies.set(INVITE_COOKIE, process.env.BETA_INVITE_CODE as string, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });
      return res;
    }
    return NextResponse.next();
  }

  if (!isProtected(pathname)) {
    return NextResponse.next();
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

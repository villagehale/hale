import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { inviteGateDecision } from '~/lib/onboarding/invite-gate';

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

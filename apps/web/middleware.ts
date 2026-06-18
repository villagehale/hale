import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';

// Paths rendered by the (authed) route group. The group name isn't part of the
// URL, so the matcher can't target it directly — we gate these prefixes by hand.
const PROTECTED_PREFIXES = [
  '/coach',
  '/companion',
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
  if (!isProtected(req.nextUrl.pathname)) {
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

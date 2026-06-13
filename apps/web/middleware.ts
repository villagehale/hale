import { NextResponse } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';
import { clerkConfigured } from '~/lib/auth-config';

// clerkMiddleware() must run for the layout's server-side auth() to work, but
// it requires keys to initialize. Without Clerk env we pass every request
// through untouched so the development-preview mode stays usable; the layout
// renders its "auth disabled" banner in that case.
export default clerkConfigured() ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};

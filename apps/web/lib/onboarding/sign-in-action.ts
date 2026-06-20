'use server';

import { signIn } from '~/auth';

/**
 * Kicks off Google OAuth from the intake wizard's Phase B, returning to Phase C
 * (?step=setup) signed in. A server action (not a client signIn) because Auth.js
 * v5's signIn runs server-side. The Phase-A intake + plan + ToS choice are already
 * in sessionStorage by the time this redirects, so they survive the round-trip.
 */
export async function startGoogleSignIn(): Promise<void> {
  await signIn('google', { redirectTo: '/onboarding?step=setup' });
}

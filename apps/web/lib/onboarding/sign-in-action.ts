'use server';

import { signIn } from '~/auth';

/**
 * Kicks off Google OAuth from the onboarding auth step (step 6), returning to
 * /onboarding signed in — where the wizard resumes at step 7 (a signed-in visitor
 * with no family yet). A server action (not a client signIn) because Auth.js v5's
 * signIn runs server-side. The pre-auth intake is already in sessionStorage by the
 * time this redirects, so it survives the round-trip and pre-fills step 7.
 */
export async function startGoogleSignIn(): Promise<void> {
  await signIn('google', { redirectTo: '/onboarding' });
}

'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { CLAIM_CODE_ERROR } from '~/lib/auth/claim-phone-copy';
import { safeInternalRedirect } from '~/lib/auth/redirect';

/**
 * Server action behind the /sign-in phone form's second step. It hands the pair
 * to Auth.js and lets the `claim-phone`
 * provider's authorize do the real work (both gates, the OTP verify, the single-use
 * burn). On success signIn throws the redirect; the authed layout then routes a
 * no-family user on to /onboarding, so there is no second copy of that gate here.
 *
 * Every failure — wrong code, expired code, a number with no account, a caregiver's
 * number, the flag being dark — comes back from authorize as the same null, surfaces
 * as one CredentialsSignin, and is shown as ONE message. The page must never be able
 * to tell a parent's number from a stranger's (rule #1).
 */

export type ClaimByPhoneState = { status: 'idle' } | { status: 'error'; message: string };

const GENERIC_ERROR = CLAIM_CODE_ERROR;

export async function claimByPhoneAction(
  phone: string,
  code: string,
  callbackUrl: string,
): Promise<ClaimByPhoneState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  const redirectTo = safeInternalRedirect(callbackUrl);
  try {
    await signIn('claim-phone', { phone, code, redirectTo });
  } catch (err) {
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: GENERIC_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; here only
  // to satisfy the action's return type. Same target, so the two cannot disagree.
  redirect(redirectTo);
}

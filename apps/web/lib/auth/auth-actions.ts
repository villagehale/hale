'use server';

import type { Database } from '@hale/db';
import { AuthError } from 'next-auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured, requireEmailVerification } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './constants';
import { registerCredential } from './credentials';
import { safeInternalRedirect } from './redirect';
import { createVerificationEmailSender } from './verification-email';

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

/**
 * Server actions for email+password sign-up and sign-in. They wrap the testable
 * core (lib/auth/credentials.ts) with the request-side concerns: per-IP rate
 * limiting, the verification email, and Auth.js sign-in. Both surface a single
 * generic error to the form so neither leaks which field was wrong or whether an
 * email is registered (rule #1).
 */

export type SignUpState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  // Account created; verification email sent (or skipped). The page tells the
  // user to check their inbox — we do NOT auto-sign-in an unverified account.
  | { status: 'check_email' };

export type SignInState = { status: 'idle' } | { status: 'error'; message: string };

const GENERIC_SIGNIN_ERROR = 'That email or password is incorrect.';

async function clientIpFromHeaders(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

async function rateLimited(): Promise<boolean> {
  const ip = await clientIpFromHeaders();
  // Fail CLOSED on this route: a limiter outage must not silently lift the
  // brute-force / signup-spam guard on an auth endpoint (rule #1).
  return (await enforceRateLimit('auth', ip, true)) !== null;
}

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-up is not available right now.' };
  }
  if (await rateLimited()) {
    return { status: 'error', message: 'Too many attempts. Please wait a minute and try again.' };
  }

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await registerCredential(email, password, db() as Database);

  if (!result.ok) {
    if (result.error === 'invalid_email') {
      return { status: 'error', message: 'Enter a valid email address.' };
    }
    if (result.error === 'weak_password') {
      return {
        status: 'error',
        message: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }
    // email_taken: never confirm an address is registered. Same "check your
    // email" outcome as a fresh sign-up, so the two are indistinguishable.
    return { status: 'check_email' };
  }

  const verifyUrl = `${APP_BASE}/verify?token=${encodeURIComponent(result.verificationToken)}`;
  // Fire-and-forget the verification email to the NORMALIZED stored address. Not
  // awaited on purpose: the response time must NOT depend on the Resend round-trip,
  // so a new vs. already-registered signup can't be told apart by latency (rule #1
  // — account-enumeration defense; the `email_taken` path above returns the same
  // state). A send failure must not fail sign-up (boundary catch, CLAUDE.md #8).
  void createVerificationEmailSender()
    .sendVerification(result.email, verifyUrl)
    .catch((err) => console.error('verification email failed (signup unaffected)', err));

  // When verification isn't enforced, the account is usable now — sign the user
  // straight in. Otherwise tell them to confirm their email first.
  if (!requireEmailVerification()) {
    await signIn('credentials', {
      email,
      password,
      redirectTo: '/onboarding?step=setup',
    });
  }

  return { status: 'check_email' };
}

export async function signInAction(
  redirectTo: string,
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }
  if (await rateLimited()) {
    return { status: 'error', message: 'Too many attempts. Please wait a minute and try again.' };
  }

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const safeRedirect = safeInternalRedirect(redirectTo);

  // Bound the password before the (CPU-heavy) argon2 verify so an unauthenticated
  // caller can't submit a multi-MB password to amplify load. Reject with the same
  // generic error so it stays non-enumerating.
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { status: 'error', message: GENERIC_SIGNIN_ERROR };
  }

  try {
    await signIn('credentials', { email, password, redirectTo: safeRedirect });
  } catch (err) {
    // Auth.js signals a failed credentials authorize as a CredentialsSignin
    // AuthError; surface ONE generic message for every cause. Any other error
    // (incl. the redirect "error" Next.js throws on success) must rethrow.
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: GENERIC_SIGNIN_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; it is
  // here only to satisfy the action's return type.
  redirect(safeRedirect);
}

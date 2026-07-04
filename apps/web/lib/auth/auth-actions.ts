'use server';

import type { Database } from '@hale/db';
import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured, requireEmailVerification } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { MIN_PASSWORD_LENGTH } from './constants';
import { registerCredential, verifyEmailToken } from './credentials';
import { authRateLimited } from './rate-limit';
import { safeInternalRedirect } from './redirect';
import {
  consumePasswordReset,
  credentialUnverified,
  requestPasswordReset,
  resendVerification,
} from './reset';
import { dispatchSignupSideEffects } from './signup-side-effects';
import { defaultSignupSideEffectDeps } from './signup-side-effects.wiring';
import { createVerificationEmailSender } from './verification-email';

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

/**
 * Server actions for email+password sign-up and sign-in. They wrap the testable
 * core (lib/auth/credentials.ts) with request-side concerns: the verification
 * email and Auth.js sign-in. Both surface a single generic error so neither leaks
 * which field was wrong or whether an email is registered (rule #1).
 *
 * The brute-force rate limit and the password length bound for SIGN-IN live at the
 * Credentials `authorize` chokepoint (auth.ts) / authenticateCredential, NOT here —
 * a direct POST to /api/auth/callback/credentials bypasses this action, so guarding
 * only here would leave that path open. Sign-UP doesn't go through authorize, so it
 * keeps its own rate limit below.
 */

export type SignUpState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  // Account created; verification email sent (or skipped). The page tells the
  // user to check their inbox — we do NOT auto-sign-in an unverified account.
  | { status: 'check_email' };

export type SignInState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  // Credentials were CORRECT but the email is unverified. Only reachable after the
  // caller proved the password, so telling them (and them alone) the account is
  // unconfirmed leaks nothing (rule #1). Carries the email so the form's "resend"
  // affordance can re-send without re-typing.
  | { status: 'unverified'; email: string };

const GENERIC_SIGNIN_ERROR = 'That email or password is incorrect.';

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-up is not available right now.' };
  }
  // Sign-up doesn't pass through the authorize chokepoint, so it carries its own
  // per-IP guard against signup spam.
  if (await authRateLimited()) {
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
  // Fire-and-forget the post-creation side-effects (verification email + founder
  // new-signup signal + server-side signup_completed analytics). Not awaited on
  // purpose: the response time must NOT depend on the Resend/PostHog round-trips, so
  // a new vs. already-registered signup can't be told apart by latency (rule #1 —
  // account-enumeration defense; the `email_taken` path above returns the same
  // state). Every effect is best-effort and swallowed inside the dispatcher, so a
  // send failure never fails sign-up (boundary catch, CLAUDE.md #8).
  const database = db() as Database;
  void dispatchSignupSideEffects(
    { db: database, email: result.email, verifyUrl },
    defaultSignupSideEffectDeps(database, result.credentialId, result.email),
  );

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

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const safeRedirect = safeInternalRedirect(redirectTo);

  // The rate limit AND the password length bound run inside the authorize
  // chokepoint (auth.ts / authenticateCredential), which this signIn call goes
  // through — so they cover the direct /api/auth/callback/credentials path too.
  // authorize returns null when limited or over-length, which Auth.js surfaces as
  // the same CredentialsSignin error handled below.
  try {
    await signIn('credentials', { email, password, redirectTo: safeRedirect });
  } catch (err) {
    // Auth.js signals a failed credentials authorize as a CredentialsSignin
    // AuthError; surface ONE generic message for every cause. Any other error
    // (incl. the redirect "error" Next.js throws on success) must rethrow.
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      // Split ONLY the unverified case out of the generic error. This re-checks
      // the SAME credentials the caller just submitted: if they are correct but
      // the email is unconfirmed, tell this caller to confirm (they proved the
      // password, so it's their own account — no enumeration). Every other cause
      // (wrong password, no such email) stays the single generic error.
      if (await credentialUnverified(email, password, db() as Database)) {
        return { status: 'unverified', email: String(email) };
      }
      return { status: 'error', message: GENERIC_SIGNIN_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; it is
  // here only to satisfy the action's return type.
  redirect(safeRedirect);
}

export type ResetRequestState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  // ALWAYS shown after a request, registered or not (anti-enumeration).
  | { status: 'sent' };

/**
 * Send a password-reset link. Anti-enumeration: whether or not the address has an
 * account, the response is the SAME `sent` state and the SAME latency (the email
 * is fire-and-forget, so a real vs. missing account can't be told apart by timing).
 * Rate-limited per-IP like sign-up (this path doesn't cross the authorize
 * chokepoint). A send failure never changes the response (boundary catch, #8).
 */
export async function requestPasswordResetAction(
  _prev: ResetRequestState,
  formData: FormData,
): Promise<ResetRequestState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Password reset is not available right now.' };
  }
  if (await authRateLimited()) {
    return { status: 'error', message: 'Too many attempts. Please wait a minute and try again.' };
  }

  const email = String(formData.get('email') ?? '');
  const result = await requestPasswordReset(email, db() as Database);

  if (result.token) {
    const resetUrl = `${APP_BASE}/reset-password?token=${encodeURIComponent(result.token)}`;
    void createVerificationEmailSender()
      .sendReset(result.email, resetUrl)
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('reset email failed (response unaffected)', { message });
      });
  }

  // Identical outcome whether or not a token was minted.
  return { status: 'sent' };
}

export type ResetPasswordState = { status: 'idle' } | { status: 'error'; message: string };

/**
 * Redeem a reset token and set a new password. On success it signs the user in and
 * redirects (no state returned). A bad/expired/used token OR a weak password
 * returns a message; `invalid_token` is deliberately generic so a probe learns
 * nothing about which tokens exist. Rate-limited per-IP (this path doesn't cross
 * the authorize chokepoint).
 */
export async function resetPasswordAction(
  token: string,
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Password reset is not available right now.' };
  }
  if (await authRateLimited()) {
    return { status: 'error', message: 'Too many attempts. Please wait a minute and try again.' };
  }

  const password = String(formData.get('password') ?? '');
  const result = await consumePasswordReset(token, password, db() as Database);

  if (!result.ok) {
    if (result.error === 'weak_password') {
      return {
        status: 'error',
        message: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }
    // invalid_token (and the impossible invalid_email) → one generic message.
    return {
      status: 'error',
      message: 'This reset link is invalid or has expired. Request a new one.',
    };
  }

  // The password now matches; sign the user straight in.
  await signIn('credentials', {
    email: result.identity.email,
    password,
    redirectTo: '/onboarding?step=setup',
  });
  redirect('/onboarding?step=setup');
}

export type VerifyState = { status: 'idle' } | { status: 'ok' } | { status: 'error' };

/**
 * Redeem an email-verification token — driven by a POST from the /verify page's
 * "Confirm my email" button, NOT a GET. That two-step is what makes verification
 * scanner-proof: link-prefetchers and inbox security scanners issue GETs, which
 * only RENDER the button; the single-use token is spent only when a human clicks.
 * A token already burned (or unknown/expired) resolves to `error`, and the page
 * offers "already confirmed? sign in".
 */
export async function confirmEmailAction(
  token: string,
  _prev: VerifyState,
  _formData: FormData,
): Promise<VerifyState> {
  if (!authConfigured()) {
    return { status: 'error' };
  }
  const redeemed = await verifyEmailToken(token, db() as Database);
  return redeemed ? { status: 'ok' } : { status: 'error' };
}

export type ResendState = { status: 'idle' } | { status: 'error'; message: string } | { status: 'sent' };

/**
 * Re-send the email-verification link. Anti-enumeration: an unverified account gets
 * a fresh link; a verified or non-existent account gets the SAME `sent` state and
 * SAME latency (fire-and-forget). Rate-limited per-IP like sign-up.
 */
export async function resendVerificationAction(
  _prev: ResendState,
  formData: FormData,
): Promise<ResendState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Verification is not available right now.' };
  }
  if (await authRateLimited()) {
    return { status: 'error', message: 'Too many attempts. Please wait a minute and try again.' };
  }

  const email = String(formData.get('email') ?? '');
  const result = await resendVerification(email, db() as Database);

  if (result.token) {
    const verifyUrl = `${APP_BASE}/verify?token=${encodeURIComponent(result.token)}`;
    void createVerificationEmailSender()
      .sendVerification(result.email, verifyUrl)
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('resend verification email failed (response unaffected)', { message });
      });
  }

  return { status: 'sent' };
}

'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';

/**
 * Server action for the /magic-link redeem page. Mirrors resetPasswordAction: it
 * calls signIn with the token and lets Auth.js run the magic-link provider's
 * authorize (validate + atomic single-use consume + find-or-create). On success
 * signIn throws the redirect to /home; the (authed) layout then routes a no-family
 * user on to /onboarding, so "existing family → /home, none → /onboarding" is the
 * one existing gate, not a second copy here.
 *
 * A token that is invalid / expired / already consumed makes authorize return null,
 * which Auth.js surfaces as a CredentialsSignin AuthError → one generic error the
 * page pairs with a "request a new link" hint. Any other error (incl. the redirect
 * Next.js throws on success) rethrows.
 */

export type MagicLinkRedeemState = { status: 'idle' } | { status: 'error'; message: string };

const GENERIC_ERROR = 'This sign-in link is invalid or has expired. Request a new one.';

export async function redeemMagicLinkAction(
  token: string,
  _prev: MagicLinkRedeemState,
  _formData: FormData,
): Promise<MagicLinkRedeemState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  try {
    await signIn('magic-link', { token, redirectTo: '/home' });
  } catch (err) {
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: GENERIC_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; here
  // only to satisfy the action's return type.
  redirect('/home');
}

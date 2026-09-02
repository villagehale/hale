'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';

/**
 * Server action for the /connect redeem page — the magic-link action's shape with a
 * FIXED destination. The link was texted for exactly one reason (connecting an
 * account), so redemption always lands on Settings -> Connected apps; there is no
 * callbackUrl input and therefore no redirect surface to clamp.
 *
 * A token that is invalid / expired / already consumed makes authorize return null,
 * which Auth.js surfaces as a CredentialsSignin AuthError → one generic error the
 * page pairs with a "text me again" hint (a fresh link is one text away — there is
 * no request-a-new-link form for a token only Hale can mint).
 */

export type ChannelLinkRedeemState = { status: 'idle' } | { status: 'error'; message: string };

const GENERIC_ERROR =
  'This link is invalid or has expired. Text Hale "connect my calendar" for a fresh one.';

/** Where every redeemed link lands: the connections section of Settings. */
const CONNECT_DESTINATION = '/settings#apps';

export async function redeemChannelLinkAction(
  token: string,
  _prev: ChannelLinkRedeemState,
  _formData: FormData,
): Promise<ChannelLinkRedeemState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  try {
    await signIn('channel-link', { token, redirectTo: CONNECT_DESTINATION });
  } catch (err) {
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: GENERIC_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; here only
  // to satisfy the action's return type.
  redirect(CONNECT_DESTINATION);
}

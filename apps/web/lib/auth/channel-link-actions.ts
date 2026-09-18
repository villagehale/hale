'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import type { TextConnectProvider } from '~/lib/channel/connect/text-connect';

/**
 * Server action for the /connect redeem page — the magic-link action's shape with a
 * destination the CALLER cannot write. The link was texted for exactly one reason
 * (connecting an account), so redemption lands either on that connector's Google
 * consent or, when the link named none, on Settings -> Connected apps. There is still
 * no callbackUrl input: the provider arrives as an allowlisted token
 * (connect/text-connect.ts), and the path is built from it rather than taken from it,
 * so there is no redirect surface to clamp.
 *
 * A token that is invalid / expired / already consumed makes authorize return null,
 * which Auth.js surfaces as a CredentialsSignin AuthError → one generic error the
 * page pairs with a "text me again" hint (a fresh link is one text away — there is
 * no request-a-new-link form for a token only Hale can mint).
 */

export type ChannelLinkRedeemState = { status: 'idle' } | { status: 'error'; message: string };

const GENERIC_ERROR =
  'This link is invalid or has expired. Text Hale "connect my calendar" for a fresh one.';

/** Where a link that named no connector lands: the connections section of Settings. */
const SETTINGS_DESTINATION = '/settings#apps';

/** `from=text` is how the consent mint learns the parent is standing in a thread, and
 * therefore that the return leg owes them a done page and a text rather than a
 * dashboard (api/integrations/[provider]/connect). */
function destination(provider: TextConnectProvider | null): string {
  return provider ? `/api/integrations/${provider}/connect?from=text` : SETTINGS_DESTINATION;
}

export async function redeemChannelLinkAction(
  token: string,
  provider: TextConnectProvider | null,
  _prev: ChannelLinkRedeemState,
  _formData: FormData,
): Promise<ChannelLinkRedeemState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  const redirectTo = destination(provider);
  try {
    await signIn('channel-link', { token, redirectTo });
  } catch (err) {
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: GENERIC_ERROR };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; here only
  // to satisfy the action's return type.
  redirect(redirectTo);
}

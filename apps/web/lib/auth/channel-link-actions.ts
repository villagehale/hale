'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { recallChannelSigninParent } from '~/lib/auth/channel-signin';
import { textFreshConnectorLink } from '~/lib/channel/connect/fresh-link';
import {
  type TextConnectProvider,
  asTextConnectProvider,
} from '~/lib/channel/connect/text-connect';
import { db } from '~/lib/db';

/**
 * Server action for the /connect redeem page — the magic-link action's shape with a
 * destination the CALLER cannot write. The link was texted for exactly one reason
 * (connecting an account), so redemption lands either on that connector's Google
 * consent or, when the link named none, on Settings -> Connected apps. There is still
 * no callbackUrl input: the provider is narrowed to the allowlist HERE, at the
 * boundary, because a bound server-action argument round-trips through the client and
 * arrives as whatever the browser sends back. The path is then built from the narrowed
 * value rather than taken from it, so there is no redirect surface to clamp.
 *
 * A token that is invalid / expired / already consumed makes authorize return null,
 * which Auth.js surfaces as a CredentialsSignin AuthError. When the token still
 * names a parent, Hale texts a fresh link for the provider on THAT link. The page
 * says a text left only when one did, and never a phrase to type.
 */

export type ChannelLinkRedeemState = { status: 'idle' } | { status: 'error'; message: string };

const EXPIRED = 'This link is invalid or has expired.';
const FRESH_SENT = 'This link is invalid or has expired. A fresh one is in your texts.';
const TRY_AGAIN = 'This link did not open. Tap it again in a moment.';

/** Where a link that named no connector lands: the connections section of Settings. */
const SETTINGS_DESTINATION = '/settings#apps';

/** `from=text` is how the consent mint learns the parent is standing in a thread, and
 * therefore that the return leg owes them a done page and a text rather than a
 * dashboard (api/integrations/[provider]/connect). */
function destination(provider: TextConnectProvider | null, tokenId?: string): string {
  if (!provider) return SETTINGS_DESTINATION;
  const path = `/api/integrations/${provider}/connect?from=text`;
  return tokenId ? `${path}&link=${tokenId}` : path;
}

export async function redeemChannelLinkAction(
  token: string,
  provider: string | null,
  _prev: ChannelLinkRedeemState,
  _formData: FormData,
): Promise<ChannelLinkRedeemState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  const named = asTextConnectProvider(provider);
  const recalled = await recallChannelSigninParent(token, db());
  // A dead link still names its parent. Text a new one for the provider they
  // tapped, and do not open Google on a token that can no longer sign them in.
  if (recalled && !recalled.usable && named) {
    const outcome = await textFreshConnectorLink(db(), {
      familyId: recalled.familyId,
      parentUserId: recalled.userId,
      provider: named,
      now: new Date(),
    });
    return { status: 'error', message: outcome === 'sent' ? FRESH_SENT : EXPIRED };
  }

  const redirectTo = destination(named, recalled?.usable ? recalled.tokenId : undefined);
  try {
    await signIn('channel-link', { token, redirectTo });
  } catch (err) {
    if (err instanceof AuthError && err.type === 'CredentialsSignin') {
      return { status: 'error', message: recalled?.usable ? TRY_AGAIN : EXPIRED };
    }
    throw err;
  }

  // signIn redirects on success, so this is unreachable on the happy path; here only
  // to satisfy the action's return type.
  redirect(redirectTo);
}

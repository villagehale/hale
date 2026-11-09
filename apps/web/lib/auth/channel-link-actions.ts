'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { recallChannelSigninParent } from '~/lib/auth/channel-signin';
import { textFreshConnectorLink } from '~/lib/channel/connect/fresh-link';
import {
  TEXT_LINK_DEFAULT_PATH,
  TEXT_LINK_PAGE_PATH,
  type TextConnectProvider,
  asTextConnectProvider,
  asTextLinkPage,
} from '~/lib/channel/connect/text-connect';
import { db } from '~/lib/db';

/**
 * Server action for the /connect redeem page, with a destination the CALLER
 * cannot write. A texted link goes where it was minted to go: a connector link to that
 * connector's Google consent, a page link to that page, and anything else to the family
 * page. There is still no callbackUrl input: `to` is narrowed to the allowlist HERE, at
 * the boundary, because a bound server-action argument round-trips through the client
 * and arrives as whatever the browser sends back. The path is then built from the
 * narrowed value rather than taken from it, so there is no redirect surface to clamp.
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

/** `from=text` is how the consent mint learns the parent is standing in a thread, and
 * therefore that the return leg owes them a done page and a text rather than a
 * dashboard (api/integrations/[provider]/connect). The link id is a consent concern
 * only, so a page destination never carries it. */
function destination(to: string | null, provider: TextConnectProvider | null, tokenId?: string) {
  if (provider) {
    const path = `/api/integrations/${provider}/connect?from=text`;
    return tokenId ? `${path}&link=${tokenId}` : path;
  }
  const page = asTextLinkPage(to);
  return page ? TEXT_LINK_PAGE_PATH[page] : TEXT_LINK_DEFAULT_PATH;
}

export async function redeemChannelLinkAction(
  token: string,
  to: string | null,
  _prev: ChannelLinkRedeemState,
  _formData: FormData,
): Promise<ChannelLinkRedeemState> {
  if (!authConfigured()) {
    return { status: 'error', message: 'Sign-in is not available right now.' };
  }

  const named = asTextConnectProvider(to);
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

  const redirectTo = destination(to, named, recalled?.usable ? recalled.tokenId : undefined);
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

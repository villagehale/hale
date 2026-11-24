'use server';

import type { Route } from 'next';
import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { auth, signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { recallChannelSigninParent } from '~/lib/auth/channel-signin';
import { createClaimCodeSender } from '~/lib/auth/claim-code-sender';
import { CLAIM_CODE_ERROR, CLAIM_RATE_LIMIT } from '~/lib/auth/claim-phone-copy';
import { connectLinkCodeEnabled, requestConnectLinkCode } from '~/lib/auth/connect-link-code';
import { authRateLimited } from '~/lib/auth/rate-limit';
import {
  REDEEM_CODE_JUST_SENT,
  REDEEM_NO_NUMBER,
  REDEEM_UNAVAILABLE,
} from '~/lib/channel/connect/connect-page-copy';
import { textFreshConnectorLink } from '~/lib/channel/connect/fresh-link';
import {
  TEXT_LINK_DEFAULT_PATH,
  TEXT_LINK_PAGE_PATH,
  type TextConnectProvider,
  asGoogleBundleLink,
  asTextConnectProvider,
  asTextLinkPage,
} from '~/lib/channel/connect/text-connect';
import { db } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';

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

export type ChannelLinkRedeemState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  /** CONNECT_LINK_CODE_ENABLED only: the page is asking for the texted code. */
  | { status: 'code'; message: string | null };

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
  // VIL-721. The one link: one Google consent for Gmail and the calendar together.
  // Dark, asGoogleBundleLink names nothing and this falls through to the family page.
  if (asGoogleBundleLink(to)) {
    const path = '/api/integrations/google/connect?from=text';
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
  const bundle = asGoogleBundleLink(to);
  const recalled = await recallChannelSigninParent(token, db());
  // A dead link still names its parent. Text a new one for the provider they
  // tapped (the one link for the one link), and do not open Google on a token that
  // can no longer sign them in.
  if (recalled && !recalled.usable && (named || bundle)) {
    const outcome = await textFreshConnectorLink(db(), {
      familyId: recalled.familyId,
      parentUserId: recalled.userId,
      // No provider named means the guard above saw the one link.
      provider: named ?? 'google',
      now: new Date(),
    });
    return { status: 'error', message: outcome === 'sent' ? FRESH_SENT : EXPIRED };
  }

  const redirectTo = destination(to, named, recalled?.usable ? recalled.tokenId : undefined);
  if (connectLinkCodeEnabled()) {
    if (!recalled?.usable) return { status: 'error', message: EXPIRED };
    return redeemWithCode(token, recalled.userId, redirectTo, _formData);
  }
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

/**
 * Holding the link is not enough. A session already signed in as the user it names goes
 * straight on. Anyone else gets a code texted to that user's number, on this tap and
 * never on page load, and the provider checks the code they bring back.
 */
async function redeemWithCode(
  token: string,
  linkUserId: string,
  redirectTo: Route,
  formData: FormData,
): Promise<ChannelLinkRedeemState> {
  const subject = (await auth())?.user?.id;
  if (subject && (await resolveUserIdForUser(subject, db())) === linkUserId) {
    redirect(redirectTo);
  }

  const typed = formData.get('code');
  const code = typeof typed === 'string' ? typed.trim() : '';
  if (code) {
    try {
      await signIn('channel-link', { token, code, redirectTo });
    } catch (err) {
      if (err instanceof AuthError && err.type === 'CredentialsSignin') {
        return { status: 'code', message: CLAIM_CODE_ERROR };
      }
      throw err;
    }
    redirect(redirectTo);
  }

  if (await authRateLimited()) return { status: 'code', message: CLAIM_RATE_LIMIT };
  const outcome = await requestConnectLinkCode(
    db(),
    { token },
    { sender: createClaimCodeSender() },
  );
  console.info({ outcome }, 'channel-link: code requested');
  switch (outcome) {
    case 'sent':
      return { status: 'code', message: null };
    case 'cooldown':
      return { status: 'code', message: REDEEM_CODE_JUST_SENT };
    case 'rate_limited':
      return { status: 'code', message: CLAIM_RATE_LIMIT };
    case 'dead_link':
      return { status: 'error', message: EXPIRED };
    case 'no_verified_number':
      return { status: 'error', message: REDEEM_NO_NUMBER };
    case 'sender_not_configured':
      return { status: 'error', message: REDEEM_UNAVAILABLE };
    case 'send_failed':
      return { status: 'error', message: TRY_AGAIN };
  }
}

import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { mintChannelSigninTokens } from '~/lib/auth/channel-signin';
import { isParentRole } from '~/lib/channel/role-scope';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The connector handoff's mint: a verified parent's plain "connect my calendar"
 * becomes a single-use, 15-minute sign-in link into that provider's Google consent.
 *
 * SCOPE IS THE ROUTED TURN'S, by construction: `parentUserId`/`familyId` come from the
 * router's job — the same forged-scope-impossible invariant the connector read tools
 * state — and this module re-proves the pair before minting anything, because a
 * sign-in link is a session and a session is the one thing that must never be minted
 * on a stale assumption. Rule #11: every way this declines is NAMED —
 * `not_enrolled`, `mint_failed` — never a silent nothing-happened.
 */

export type ConnectorOfferOutcome =
  | { status: 'minted'; url: string }
  /** No ACTIVE verified parent channel behind this user+family pair. Unreachable from
   * the router (it does not reach the handlers without one) — which is exactly why it
   * is re-checked and named rather than assumed. */
  | { status: 'not_enrolled' }
  /** The token or audit write did not land. The parent gets the honest failure line;
   * the ask costs them nothing and a retry mints cleanly. */
  | { status: 'mint_failed' };

/** Where the link lands: the redeem page, which signs the parent in and forwards them
 * straight into this provider's Google consent — no Settings, no Connect button to
 * find. Always the app host (appBaseUrl), never the marketing site: this is an app door.
 * A provider with no text-back path carries no `to` and keeps the Settings landing. */
function connectUrl(token: string, provider: ConnectorProvider): string {
  const deepLink = asTextConnectProvider(provider);
  return `${appBaseUrl()}/connect?t=${token}${deepLink ? `&to=${deepLink}` : ''}`;
}

/** At least one provider, as a tuple, so the URLs come back one-per-provider in the
 * order asked and a caller offering two never has to prove to the compiler that its
 * second link exists. */
type ProviderList = readonly [ConnectorProvider, ...ConnectorProvider[]];

export type ConnectorLinksOutcome<P extends ProviderList> =
  | { status: 'minted'; urls: { [K in keyof P]: string } }
  | { status: 'not_enrolled' }
  | { status: 'mint_failed' };

/** The single-provider door — what a parent's "connect my calendar" earns. */
export async function offerConnectorLink(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    provider: ConnectorProvider;
    now: Date;
  },
): Promise<ConnectorOfferOutcome> {
  const outcome = await offerConnectorLinks(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    providers: [input.provider],
    now: input.now,
  });
  return outcome.status === 'minted' ? { status: 'minted', url: outcome.urls[0] } : outcome;
}

/**
 * The links of ONE message: a token and an audit row per provider, minted together so
 * they outlive each other. A message that names Calendar and Gmail carries a link for
 * each — the whole point of the texted connect is that neither tap passes through the
 * portal, and a second link fetched by a second text is a second chance to lose the
 * parent.
 */
export async function offerConnectorLinks<const P extends ProviderList>(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    providers: P;
    now: Date;
  },
): Promise<ConnectorLinksOutcome<P>> {
  // The two gates the claim flow keeps, re-proven here rather than inherited: an
  // ACTIVE verified non-revoked channel, and a parent seat in the family the job
  // names. A caregiver or a STOPped number gets no session link, ever.
  const [phone, membership] = await Promise.all([
    resolveSendablePhone(database, input.parentUserId),
    database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, input.familyId),
          eq(schema.familyMembers.userId, input.parentUserId),
        ),
      )
      .limit(1),
  ]);
  if (!phone || !membership[0] || !isParentRole(membership[0].role)) {
    return { status: 'not_enrolled' };
  }

  try {
    // One transaction: the capabilities and the record of minting them land together,
    // or none does (the mintJoinInvite discipline). A token row with no audit row
    // would be an act rule #6 cannot answer for.
    const links = await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const minted = await mintChannelSigninTokens(tx, {
        userId: input.parentUserId,
        count: input.providers.length,
        now: input.now,
      });
      const paired = input.providers.map((provider, index) => {
        const token = minted[index];
        if (!token) throw new Error('offerConnectorLinks: fewer tokens minted than providers');
        return { provider, token };
      });

      // Rule #6: each mint is an act. The row names the provider asked for and nothing
      // else — never the token, never the number (rule #1).
      await tx.insert(schema.auditLog).values(
        paired.map(({ provider, token }) => ({
          familyId: input.familyId,
          actor: input.parentUserId,
          actionTaken: 'connector_link_minted',
          targetTable: 'channel_signin_tokens',
          targetId: token.tokenId,
          after: { provider },
          occurredAt: input.now,
        })),
      );
      return paired.map(({ provider, token }) => connectUrl(token.token, provider));
    });

    // One URL per provider, in the order asked — established by the map above, which
    // `map` cannot carry back into the tuple type.
    return { status: 'minted', urls: links as { [K in keyof P]: string } };
  } catch {
    // Named rather than thrown (rule #11): a thrown handler would defer the whole turn
    // into hours of queue backoff for a link the parent asked for NOW, and the honest
    // failure line with a working retry is the better answer. The caller logs it.
    return { status: 'mint_failed' };
  }
}

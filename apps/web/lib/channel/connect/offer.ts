import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { mintChannelSigninToken } from '~/lib/auth/channel-signin';
import { isParentRole } from '~/lib/channel/role-scope';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The connector handoff's mint: a verified parent's plain "connect my calendar"
 * becomes a single-use, 15-minute sign-in link to the settings connections surface.
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
 * to Settings -> Connected apps. Always the app host (appBaseUrl), never the
 * marketing site — this is an app door. */
function connectUrl(token: string): string {
  return `${appBaseUrl()}/connect?t=${token}`;
}

export async function offerConnectorLink(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    provider: ConnectorProvider;
    now: Date;
  },
): Promise<ConnectorOfferOutcome> {
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
    // One transaction: the capability and the record of minting it land together, or
    // neither does (the mintJoinInvite discipline). A token row with no audit row
    // would be an act rule #6 cannot answer for.
    const token = await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const minted = await mintChannelSigninToken(tx, {
        userId: input.parentUserId,
        now: input.now,
      });

      // Rule #6: the mint is an act. The row names the provider asked for and nothing
      // else — never the token, never the number (rule #1).
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: 'connector_link_minted',
        targetTable: 'channel_signin_tokens',
        targetId: minted.tokenId,
        after: { provider: input.provider },
        occurredAt: input.now,
      });
      return minted.token;
    });

    return { status: 'minted', url: connectUrl(token) };
  } catch {
    // Named rather than thrown (rule #11): a thrown handler would defer the whole turn
    // into hours of queue backoff for a link the parent asked for NOW, and the honest
    // failure line with a working retry is the better answer. The caller logs it.
    return { status: 'mint_failed' };
  }
}

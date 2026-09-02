import { createHash, randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import { MAGIC_LINK_TTL_MS } from './magic-link';

/**
 * The phone-channel sign-in token — the magic-link lifecycle keyed on `user_id`, for
 * the account an email link cannot reach (email NULL, `external_auth_id =
 * 'sms:<blind index>'`). Minted only from a routed inbound turn (the caller owns that
 * gate — see channel/connect/offer.ts); redeemed by the `channel-link` Auth.js
 * provider, whose session subject is the external_auth_id the account ALREADY has, so
 * redemption can never fork a second account off the same family (the claim-by-phone
 * anti-fork property, link-shaped).
 *
 * Hash-only at rest, single-use via an atomic conditional burn, 15-minute TTL, and
 * invalidate-prior-on-mint — each one the magic-link convention, kept deliberately
 * byte-for-byte in behaviour so there is one story about what a Hale sign-in link is.
 */

/** Same window as the email magic link — one product promise about what "a sign-in
 * link from Hale" is good for, stated once. */
export const CHANNEL_SIGNIN_TTL_MS = MAGIC_LINK_TTL_MS;

/**
 * 16 bytes — the join link's call, for the join link's reason: unguessable at any
 * scale, and short enough that the URL plus a sentence stays one SMS segment. 22
 * base64url characters against a 15-minute, single-use window.
 */
const TOKEN_BYTES = 16;

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 suffices for a 128-bit random token: no low-entropy input to stretch
 * (argon2 is for passwords). The stored hash is what the redeem lookup matches. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a sign-in token for a user we already hold. Invalidates the user's prior
 * unconsumed tokens first — only the newest link works — and returns the raw token
 * exactly once, for the SMS that carries it; the DB keeps only the digest.
 */
export async function mintChannelSigninToken(
  database: Database,
  input: { userId: string; now: Date },
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  await database
    .update(schema.channelSigninTokens)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(schema.channelSigninTokens.userId, input.userId),
        isNull(schema.channelSigninTokens.consumedAt),
      ),
    );

  const token = newToken();
  const expiresAt = new Date(input.now.getTime() + CHANNEL_SIGNIN_TTL_MS);
  const [row] = await database
    .insert(schema.channelSigninTokens)
    .values({ userId: input.userId, tokenHash: hashToken(token), expiresAt, createdAt: input.now })
    .returning({ id: schema.channelSigninTokens.id });
  if (!row) {
    throw new Error('mintChannelSigninToken: channel_signin_tokens insert returned no row');
  }

  return { token, tokenId: row.id, expiresAt };
}

export type ChannelSigninConsumeResult =
  | { ok: true; identity: { id: string; email: null } }
  /** The reason is for the SERVER's log. Every refusal is one generic failure to the
   * caller — never which gate closed (rule #1). */
  | { ok: false; reason: 'not_usable' | 'no_identity' | 'no_family' | 'spent' };

/**
 * Redeem a token: resolve the identity first (a refusal must not cost the parent
 * their link — the claim-by-phone ordering), then burn it with the same atomic
 * conditional UPDATE the magic link uses, with the audit row (rule #6) in the same
 * transaction. `{ ok: false }` covers unknown, expired, and already-consumed alike,
 * so a probe learns nothing.
 */
export async function consumeChannelSigninToken(
  token: string,
  database: Database,
  opts?: { now?: Date },
): Promise<ChannelSigninConsumeResult> {
  const now = opts?.now ?? new Date();
  // A real token is 22 base64url chars; its hash is 64 hex. Reject implausible probes
  // before the indexed lookup, the magic-link guard verbatim.
  if (!token || token.length > 64) {
    return { ok: false, reason: 'not_usable' };
  }

  const [pending] = await database
    .select({ id: schema.channelSigninTokens.id, userId: schema.channelSigninTokens.userId })
    .from(schema.channelSigninTokens)
    .where(
      and(
        eq(schema.channelSigninTokens.tokenHash, hashToken(token)),
        isNull(schema.channelSigninTokens.consumedAt),
        gt(schema.channelSigninTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!pending) return { ok: false, reason: 'not_usable' };

  const [user] = await database
    .select({ externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.id, pending.userId))
    .limit(1);
  const externalAuthId = user?.externalAuthId;
  if (!externalAuthId) return { ok: false, reason: 'no_identity' };

  // The family for the audit row — the parent membership, mirroring the claim flow.
  const memberships = await database
    .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, pending.userId));
  const familyId = memberships.find((m) => isParentRole(m.role))?.familyId;
  if (!familyId) return { ok: false, reason: 'no_family' };

  const burned = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const spent = await tx
      .update(schema.channelSigninTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.channelSigninTokens.id, pending.id),
          isNull(schema.channelSigninTokens.consumedAt),
          gt(schema.channelSigninTokens.expiresAt, now),
        ),
      )
      .returning({ id: schema.channelSigninTokens.id });
    if (!spent[0]) return false;

    // Rule #6. Coarse on purpose: WHO signed in, WHEN, and by which door. The token
    // has no business in the record of presenting it (rule #1).
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: pending.userId,
      actionTaken: 'connector_link_signed_in',
      targetTable: 'channel_signin_tokens',
      targetId: pending.id,
      occurredAt: now,
    });
    return true;
  });

  if (!burned) return { ok: false, reason: 'spent' };

  return { ok: true, identity: { id: externalAuthId, email: null } };
}

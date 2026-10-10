import { createHash, randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';

/**
 * The phone-channel sign-in token, keyed on `user_id`, for the account a text
 * reaches (`external_auth_id = 'sms:<blind index>'`). Minted only from a routed
 * inbound turn (the caller owns that gate — see channel/connect/offer.ts); redeemed
 * by the `channel-link` Auth.js provider, whose session subject is the
 * external_auth_id the account ALREADY has, so redemption can never fork a second
 * account off the same family (the claim-by-phone anti-fork property, link-shaped).
 *
 * Hash-only at rest, 15-minute TTL, and invalidate-prior. Presenting the link signs
 * the parent in and does NOT burn it: an abandoned Google screen must leave the same
 * URL usable. The burn happens when that connector's consent succeeds, or when a
 * newer ask invalidates the row. The unit of "prior" is the ASK, not the link: one
 * message may offer two connectors, and its two links must outlive each other.
 */

/** 15 minutes. A texted /connect link is good for one short window. */
export const CHANNEL_SIGNIN_TTL_MS = 15 * 60 * 1000;

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

export interface MintedChannelSigninToken {
  token: string;
  tokenId: string;
  expiresAt: Date;
}

/**
 * Issue the sign-in tokens of ONE ask for a user we already hold — `count` of them,
 * one per link the message will carry. The user's prior unconsumed tokens are
 * invalidated once, up front, so only the newest ask works; the tokens of that ask
 * coexist, because a message offering Calendar and Gmail must not hand the parent a
 * link its own sibling killed. Each raw token is returned exactly once, for the SMS
 * that carries it; the DB keeps only the digests.
 */
export async function mintChannelSigninTokens(
  database: Database,
  input: { userId: string; count: number; now: Date; invalidatePrior?: boolean },
): Promise<MintedChannelSigninToken[]> {
  // A fresh ask kills every unconsumed link. A continuation of the SAME ask
  // (the Gmail card finishing after the calendar card already left) must not:
  // invalidate-prior is per ask, and the sibling is already in the thread.
  if (input.invalidatePrior !== false) {
    await database
      .update(schema.channelSigninTokens)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(schema.channelSigninTokens.userId, input.userId),
          isNull(schema.channelSigninTokens.consumedAt),
        ),
      );
  }

  const expiresAt = new Date(input.now.getTime() + CHANNEL_SIGNIN_TTL_MS);
  const minted: MintedChannelSigninToken[] = [];
  // One INSERT per token rather than one multi-row INSERT: the id a token is paired
  // with is an audit row's target (rule #6), and pairing by RETURNING order would rest
  // on an ordering Postgres does not promise.
  for (let i = 0; i < input.count; i += 1) {
    const token = newToken();
    const [row] = await database
      .insert(schema.channelSigninTokens)
      .values({
        userId: input.userId,
        tokenHash: hashToken(token),
        expiresAt,
        createdAt: input.now,
      })
      .returning({ id: schema.channelSigninTokens.id });
    if (!row) {
      throw new Error('mintChannelSigninTokens: channel_signin_tokens insert returned no row');
    }
    minted.push({ token, tokenId: row.id, expiresAt });
  }

  return minted;
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

/**
 * Sign-in for the Redeem tap. Same gates as {@link consumeChannelSigninToken}, and
 * the same audit row, but the row stays unconsumed. Consent success burns it.
 */
export async function presentChannelSigninToken(
  token: string,
  database: Database,
  opts?: { now?: Date },
): Promise<
  | { ok: true; identity: { id: string; email: null }; tokenId: string }
  | { ok: false; reason: 'not_usable' | 'no_identity' | 'no_family' }
> {
  const now = opts?.now ?? new Date();
  const pending = await usableChannelSigninToken(token, database, now);
  if (!pending) return { ok: false, reason: 'not_usable' };

  const identity = await channelSigninIdentity(database, pending.userId);
  if (!identity.ok) return identity;

  await database.insert(schema.auditLog).values({
    familyId: identity.familyId,
    actor: pending.userId,
    actionTaken: 'connector_link_signed_in',
    targetTable: 'channel_signin_tokens',
    targetId: pending.id,
    occurredAt: now,
  });

  return { ok: true, identity: { id: identity.externalAuthId, email: null }, tokenId: pending.id };
}

/**
 * Who a token belongs to, including one that is already spent or expired. The
 * failure page uses this to text a fresh link without telling the parent a phrase
 * to type. Unknown tokens return null — there is nobody to text.
 */
export async function recallChannelSigninParent(
  token: string,
  database: Database,
  opts?: { now?: Date },
): Promise<{ userId: string; familyId: string; tokenId: string; usable: boolean } | null> {
  const now = opts?.now ?? new Date();
  if (!token || token.length > 64) return null;
  const [row] = await database
    .select({
      id: schema.channelSigninTokens.id,
      userId: schema.channelSigninTokens.userId,
      consumedAt: schema.channelSigninTokens.consumedAt,
      expiresAt: schema.channelSigninTokens.expiresAt,
    })
    .from(schema.channelSigninTokens)
    .where(eq(schema.channelSigninTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  const identity = await channelSigninIdentity(database, row.userId);
  if (!identity.ok) return null;
  return {
    userId: row.userId,
    familyId: identity.familyId,
    tokenId: row.id,
    usable: row.consumedAt === null && row.expiresAt > now,
  };
}

/** True when this unconsumed, unexpired token belongs to the signed-in user. */
export async function channelSigninTokenBelongsToUser(
  database: Database,
  input: { tokenId: string; userId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [row] = await database
    .select({
      userId: schema.channelSigninTokens.userId,
      consumedAt: schema.channelSigninTokens.consumedAt,
      expiresAt: schema.channelSigninTokens.expiresAt,
    })
    .from(schema.channelSigninTokens)
    .where(eq(schema.channelSigninTokens.id, input.tokenId))
    .limit(1);
  return (
    row?.userId === input.userId &&
    row.consumedAt === null &&
    row.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Burn the link whose id rode along in the signed connect state. Consent has
 * already succeeded. A miss is named: the connection stays stored either way.
 */
export async function consumeChannelSigninTokenById(
  database: Database,
  input: { tokenId: string; userId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: 'not_usable' | 'spent' }> {
  const now = input.now ?? new Date();
  const identity = await channelSigninIdentity(database, input.userId);
  if (!identity.ok) return { ok: false, reason: 'not_usable' };

  const burned = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const spent = await tx
      .update(schema.channelSigninTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.channelSigninTokens.id, input.tokenId),
          eq(schema.channelSigninTokens.userId, input.userId),
          isNull(schema.channelSigninTokens.consumedAt),
          gt(schema.channelSigninTokens.expiresAt, now),
        ),
      )
      .returning({ id: schema.channelSigninTokens.id });
    if (!spent[0]) return false;
    await tx.insert(schema.auditLog).values({
      familyId: identity.familyId,
      actor: input.userId,
      actionTaken: 'connector_link_signed_in',
      targetTable: 'channel_signin_tokens',
      targetId: input.tokenId,
      occurredAt: now,
    });
    return true;
  });
  return burned ? { ok: true } : { ok: false, reason: 'spent' };
}

async function usableChannelSigninToken(
  token: string,
  database: Database,
  now: Date,
): Promise<{ id: string; userId: string } | null> {
  if (!token || token.length > 64) return null;
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
  return pending ?? null;
}

async function channelSigninIdentity(
  database: Database,
  userId: string,
): Promise<
  | { ok: true; externalAuthId: string; familyId: string }
  | { ok: false; reason: 'no_identity' | 'no_family' }
> {
  const [user] = await database
    .select({ externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const externalAuthId = user?.externalAuthId;
  if (!externalAuthId) return { ok: false, reason: 'no_identity' };
  const memberships = await database
    .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId));
  const familyId = memberships.find((m) => isParentRole(m.role))?.familyId;
  if (!familyId) return { ok: false, reason: 'no_family' };
  return { ok: true, externalAuthId, familyId };
}

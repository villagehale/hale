import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { joinTokenHash, mintJoinCode } from './code';

/**
 * The co-parent join link's two writes: minting the capability, and spending it.
 *
 * THE PARENT'S REQUEST IS THE AUTHORISATION. The caregiver flow asks a question and
 * reads a yes, because it is about to text a stranger and the parent has to agree to
 * that specific disclosure. Nothing is texted here, so there is nothing to confirm: the
 * sentence "add my partner" IS the decision, and it is recorded as one
 * (`co_parent_access_grant`, with the parent's own words as evidence) at the moment the
 * link exists rather than at the moment somebody opens it. That ordering matters — the
 * capability and the record of who authorised it are the same transaction.
 *
 * A SECOND LINK DOES NOT KILL THE FIRST. The magic-link table invalidates its
 * predecessors because a stale sign-in link is pure risk; here the parent has usually
 * already forwarded it, and revoking it would strand the person holding it with an
 * ordinary greeting and a new household. What bounds the surface instead is what each
 * token can do: one seat, one use, seven days, and no way to mint one except from an
 * enrolled parent's own verified number (which the inbound rate limit already meters).
 *
 * VERIFIED BY ORIGINATION, no OTP — the same argument intake provisioning and caregiver
 * acceptance both make: the redemption ARRIVED from the number we are about to text.
 */

/** How long a forwarded link stays good. Long enough to sit unread in a busy thread
 * over a weekend, short enough that a link in an old text is not a live key. */
export const JOIN_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The CASL basis recorded on the joining co-parent's channel consent: they texted US
 * first, exactly as an intake arrival does. */
export const JOIN_CONSENT_SCOPE = 'sms_join_origination';

/** What the parent's authorisation is scoped to. The role, because the role IS the
 * scope (role-scope.ts) — a co_parent sees everything the inviting parent sees. */
export const JOIN_GRANT_SCOPE = 'family_role:co_parent';

export interface JoinInvite {
  id: string;
  familyId: string;
  invitedByUserId: string;
  role: 'co_parent';
  expiresAt: Date;
}

interface JoinInviteRow {
  id: string;
  familyId: string;
  invitedByUserId: string;
  tokenHash: string;
  role: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

const INVITE_COLUMNS = {
  id: schema.joinInvites.id,
  familyId: schema.joinInvites.familyId,
  invitedByUserId: schema.joinInvites.invitedByUserId,
  tokenHash: schema.joinInvites.tokenHash,
  role: schema.joinInvites.role,
  expiresAt: schema.joinInvites.expiresAt,
  consumedAt: schema.joinInvites.consumedAt,
};

/**
 * Mint a link and record the authorisation behind it, in one transaction. Returns the
 * code — the only time it exists outside the parent's phone, since the row keeps just
 * its digest.
 */
export async function mintJoinInvite(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string;
    verbatimRequest: string;
    channelMessageId: string | null;
    now: Date;
  },
): Promise<{ code: string }> {
  const code = mintJoinCode();
  const expiresAt = new Date(input.now.getTime() + JOIN_LINK_TTL_MS);

  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [row] = await tx
      .insert(schema.joinInvites)
      .values({
        familyId: input.familyId,
        invitedByUserId: input.invitedByUserId,
        tokenHash: joinTokenHash(code),
        role: 'co_parent',
        expiresAt,
        // Both written explicitly rather than left to the column's default/absence: the
        // reader below decides "is this link still good" by comparing these two against
        // now, and a meter that depends on the clock the row was written by cannot be
        // reasoned about (the same call `startCaregiverInvite` makes about createdAt).
        consumedAt: null,
        createdAt: input.now,
      })
      .returning({ id: schema.joinInvites.id });
    const id = row?.id;
    if (!id) {
      throw new Error('mintJoinInvite: join_invites insert returned no row');
    }

    await tx.insert(schema.consentRecords).values({
      userId: input.invitedByUserId,
      familyId: input.familyId,
      consentType: 'co_parent_access_grant',
      granted: true,
      consentScope: JOIN_GRANT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: {
        verbatimReply: input.verbatimRequest,
        interpretation:
          'parent asked for a co-parent join link, authorising full family access for whoever redeems it',
        channelMessageId: input.channelMessageId,
      },
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.invitedByUserId,
      actionTaken: 'co_parent_join_link_minted',
      targetTable: 'join_invites',
      targetId: id,
      after: { role: 'co_parent', expiresAt: expiresAt.toISOString() },
    });
  });

  return { code };
}

/**
 * The invite a forwarded code still buys, or null. Expiry and the single-use burn are
 * applied ON READ, so a sweep that never runs cannot leave a dead link live — and null
 * is an ORDINARY answer here, not an error: a link outlives the family that made it, a
 * bystander gets a forward that was already spent, somebody mistypes.
 */
export async function loadOpenJoinInvite(
  database: Database,
  code: string,
  now: Date,
): Promise<JoinInvite | null> {
  const hash = joinTokenHash(code);
  const rows = (await database
    .select(INVITE_COLUMNS)
    .from(schema.joinInvites)
    .where(eq(schema.joinInvites.tokenHash, hash))) as JoinInviteRow[];
  // Post-filtered rather than trusted, the shape every other channel lookup keeps: a
  // widened query must never resolve a spent or lapsed link.
  const row = rows.find(
    (r) =>
      r.tokenHash === hash &&
      r.consumedAt === null &&
      new Date(r.expiresAt).getTime() > now.getTime(),
  );
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.familyId,
    invitedByUserId: row.invitedByUserId,
    role: 'co_parent',
    expiresAt: new Date(row.expiresAt),
  };
}

/** The users row for this number, created if absent. Keyed by the SAME blind index
 * intake and the caregiver flow use, so somebody who already knows Hale from another
 * household is one account rather than two. */
async function ensureJoinUser(tx: Database, externalAuthId: string): Promise<string> {
  await tx
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null })
    .onConflictDoNothing({ target: schema.users.externalAuthId });

  const rows = await tx
    .select({ id: schema.users.id, externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId));
  const row = rows.find((r) => r.externalAuthId === externalAuthId);
  if (!row) {
    throw new Error('ensureJoinUser: no users row after upsert');
  }
  return row.id;
}

/**
 * Spend the link. In ONE transaction: the partner's identity, their own CASL consent,
 * their verified channel, their membership, the token's burn, and the audit trail. A
 * crash anywhere leaves none of it — there is no state in which a co-parent is a member
 * of a family without the consent row saying they agreed to be.
 */
export async function redeemJoinInvite(
  database: Database,
  input: { invite: JoinInvite; phoneE164: string; verbatimReply: string; now: Date },
): Promise<{ coParentUserId: string }> {
  const { invite, phoneE164, now } = input;
  const hash = phoneBlindIndex(phoneE164);

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const coParentUserId = await ensureJoinUser(tx, `sms:${hash}`);

    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: coParentUserId,
        familyId: invite.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: JOIN_CONSENT_SCOPE,
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.verbatimReply,
          interpretation: 'co-parent originated contact by texting their join link',
        },
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consent?.id;
    if (!consentId) {
      throw new Error('redeemJoinInvite: consent insert returned no row');
    }

    const [channel] = await tx
      .insert(schema.parentChannels)
      .values({
        userId: coParentUserId,
        familyId: invite.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(phoneE164),
        phoneE164Hash: hash,
        // Verified by origination: the redemption arrived FROM the number.
        verifiedAt: now,
        consentRecordId: consentId,
      })
      .returning({ id: schema.parentChannels.id });
    const channelId = channel?.id;
    if (!channelId) {
      throw new Error('redeemJoinInvite: parent_channels insert returned no row');
    }

    await tx
      .insert(schema.familyMembers)
      .values({
        familyId: invite.familyId,
        userId: coParentUserId,
        role: invite.role,
        invitedByUserId: invite.invitedByUserId,
      })
      // Somebody who was in this household before (a caregiver who is now a parent, a
      // co-parent who left) lands on the same PK. The role that was just consented to
      // is the one that wins.
      .onConflictDoUpdate({
        target: [schema.familyMembers.familyId, schema.familyMembers.userId],
        set: { role: invite.role, invitedByUserId: invite.invitedByUserId },
      });

    await tx
      .update(schema.joinInvites)
      .set({ consumedAt: now, consumedByUserId: coParentUserId })
      .where(eq(schema.joinInvites.id, invite.id));

    await tx.insert(schema.auditLog).values([
      {
        familyId: invite.familyId,
        actor: coParentUserId,
        actionTaken: 'co_parent_join_accepted',
        targetTable: 'family_members',
        targetId: invite.id,
        after: { role: invite.role, maskedPhone: maskPhoneE164(phoneE164) },
      },
      {
        familyId: invite.familyId,
        actor: coParentUserId,
        actionTaken: 'channel_sms_enrolled',
        targetTable: 'parent_channels',
        targetId: channelId,
        after: {
          kind: 'sms',
          maskedPhone: maskPhoneE164(phoneE164),
          verification: 'co_parent_join_link',
        },
      },
    ]);

    return { coParentUserId };
  });
}

import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type CoParentInvite,
  supersedeOpenInviteOnEnrollment,
} from '~/lib/channel/caregiver/invites';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';

/**
 * VIL-355 · the invitee's YES — the second half of the double opt-in, and the only place
 * an SMS invite turns into a co-parent seat.
 *
 * ITS OWN CONSENT SCOPE. The row is `sms_service_messages`, like every other CASL express
 * consent given from a number itself, but scoped `sms_coparent_invite_reply` rather than
 * the join link's `sms_join_origination`: that scope is a claim about who started the
 * conversation, and on this path Hale did. A ledger that said otherwise would be the one
 * record a CASL audit reads first, saying the opposite of what happened.
 *
 * THE CLOSE IS THE CLAIM, AND IT GOES FIRST — the discipline `redeemJoinInvite` already
 * keeps. The invite was read outside this transaction, so by the time we are here the same
 * forwarded thread may have produced a second YES: the conditional UPDATE re-tests
 * `closed_at IS NULL` against the locked row, and the loser matches nothing and is
 * returned null. Without it both would run, and the second would hit
 * `parent_channels_phone_hash_active_idx` and take the webhook down with a 500 the
 * carrier then retries.
 */
export interface CoParentSeated {
  coParentUserId: string;
  /** A CAREGIVER invite that was also in flight on this number, closed by the same
   * transaction (rule #11 — the absence is named, never inferred from a `closed_at`
   * somebody went looking for). Null is the ordinary case. */
  supersededInviteId: string | null;
}

/** The users row for this number, created if absent. Keyed by the SAME blind index intake,
 * the caregiver flow and the join link use, so somebody Hale already knows from another
 * household is one account rather than two. */
async function ensureCoParentUser(tx: Database, externalAuthId: string): Promise<string> {
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
    throw new Error('ensureCoParentUser: no users row after upsert');
  }
  return row.id;
}

/** What the invitee agreed to be texted, on their own account. Distinct from the join
 * link's scope: see the module note. */
export const CO_PARENT_INVITE_CONSENT_SCOPE = 'sms_coparent_invite_reply';

export async function acceptCoParentInvite(
  database: Database,
  input: { invite: CoParentInvite; verbatimReply: string; now: Date },
): Promise<CoParentSeated | null> {
  const { invite, now } = input;
  const hash = phoneBlindIndex(invite.phoneE164);

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const claimed = await tx
      .update(schema.caregiverInvites)
      .set({ state: 'accepted', closedAt: now, updatedAt: now })
      .where(
        and(eq(schema.caregiverInvites.id, invite.id), isNull(schema.caregiverInvites.closedAt)),
      )
      .returning({ id: schema.caregiverInvites.id });
    if (claimed.length === 0) return null;

    const coParentUserId = await ensureCoParentUser(tx, `sms:${hash}`);

    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: coParentUserId,
        familyId: invite.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.verbatimReply,
          interpretation:
            'co-parent accepted, from their own number, the one invite Hale sent them',
        },
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consent?.id;
    if (!consentId) {
      throw new Error('acceptCoParentInvite: consent insert returned no row');
    }

    const [channel] = await tx
      .insert(schema.parentChannels)
      .values({
        userId: coParentUserId,
        familyId: invite.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(invite.phoneE164),
        phoneE164Hash: hash,
        // Verified by origination: the acceptance arrived FROM the number.
        verifiedAt: now,
        consentRecordId: consentId,
      })
      .returning({ id: schema.parentChannels.id });
    const channelId = channel?.id;
    if (!channelId) {
      throw new Error('acceptCoParentInvite: parent_channels insert returned no row');
    }

    await tx
      .insert(schema.familyMembers)
      .values({
        familyId: invite.familyId,
        userId: coParentUserId,
        role: 'co_parent',
        invitedByUserId: invite.invitedByUserId,
      })
      // Somebody who was in this household before — a caregiver who is now the other
      // parent, a co-parent who left — lands on the same PK. The role that was just
      // consented to is the one that wins.
      .onConflictDoUpdate({
        target: [schema.familyMembers.familyId, schema.familyMembers.userId],
        set: { role: 'co_parent', invitedByUserId: invite.invitedByUserId },
      });

    await tx
      .update(schema.caregiverInvites)
      .set({ caregiverUserId: coParentUserId })
      .where(eq(schema.caregiverInvites.id, invite.id));

    // Any OTHER invite in flight on this same number closes here, inside the transaction
    // that seats them, because the two rows describe one phone and only one can be true.
    // An invite left armed outranks the channel just written — the intake machine reads
    // invites first, by design — so a crash between the seat and the closure would leave
    // a co-parent whose every message is answered with an invite's yes/no question.
    const supersededInviteId = await supersedeOpenInviteOnEnrollment(tx, {
      phoneE164: invite.phoneE164,
      via: 'co_parent_join',
      now,
    });

    await tx.insert(schema.auditLog).values([
      {
        familyId: invite.familyId,
        actor: coParentUserId,
        actionTaken: 'co_parent_invite_accepted',
        targetTable: 'family_members',
        targetId: invite.id,
        after: { role: 'co_parent', maskedPhone: maskPhoneE164(invite.phoneE164) },
      },
      {
        familyId: invite.familyId,
        actor: coParentUserId,
        actionTaken: 'channel_sms_enrolled',
        targetTable: 'parent_channels',
        targetId: channelId,
        after: {
          kind: 'sms',
          maskedPhone: maskPhoneE164(invite.phoneE164),
          verification: 'co_parent_invite_reply',
        },
      },
    ]);

    return { coParentUserId, supersededInviteId };
  });
}

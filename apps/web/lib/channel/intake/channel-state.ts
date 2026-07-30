import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { SMS_CONSENT_SCOPE } from '~/lib/channels/sms-consent-copy';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';

/**
 * VIL-237 · M2 — the two channel operations intake needs that the enrolment engine
 * (lib/channels/sms-consent-core) does not already provide. Everything else reuses it:
 * `resolveVerifiedChannelByPhone` for "who is this number", `revokeSmsChannel` for
 * STOP. Only the START path is new, because the web flow has no equivalent.
 */

export interface RevokedChannelOwner {
  userId: string;
  familyId: string;
}

/**
 * The family behind a number whose channel was revoked (a previous STOP). Looked up by
 * the blind index like every other number lookup — the raw value is never stored.
 * Newest first: a recycled number's most recent owner is the one who is texting now.
 */
export async function findRevokedChannelOwner(
  database: Database,
  phoneE164: string,
): Promise<RevokedChannelOwner | null> {
  const [row] = await database
    .select({
      userId: schema.parentChannels.userId,
      familyId: schema.parentChannels.familyId,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(phoneE164)),
        isNotNull(schema.parentChannels.revokedAt),
      ),
    )
    .orderBy(desc(schema.parentChannels.createdAt))
    .limit(1);
  // Defense in depth, mirroring resolveVerifiedChannelByPhone: only ever hand back a
  // genuinely REVOKED row. Re-enrolling on top of a live channel would append a second
  // consent for a subscription that was never cancelled.
  if (!row || row.revokedAt === null) return null;
  return { userId: row.userId, familyId: row.familyId };
}

/**
 * Re-enrol a number after a STOP, on the parent's own START.
 *
 * The keyword IS the express consent, and it is the strongest kind we can get: the
 * parent typed the word themselves, from the number in question, unprompted. So the
 * new consent row carries the verbatim keyword as its evidence rather than asserting
 * that consent was "restored". A fresh parent_channels row is inserted (never an
 * un-revoke of the old one) so the revoked row survives as the record that they were
 * once unsubscribed — history that CASL disputes turn on.
 */
export async function reenrolOnStart(
  database: Database,
  input: { userId: string; familyId: string; phoneE164: string; verbatimReply: string },
  now: Date,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: input.userId,
        familyId: input.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: SMS_CONSENT_SCOPE,
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.verbatimReply,
          interpretation: 'CASL START keyword sent from the number itself',
        },
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consent?.id;
    if (!consentId) {
      throw new Error('reenrolOnStart: consent insert returned no row');
    }

    const [channel] = await tx
      .insert(schema.parentChannels)
      .values({
        userId: input.userId,
        familyId: input.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(input.phoneE164),
        phoneE164Hash: phoneBlindIndex(input.phoneE164),
        verifiedAt: now,
        consentRecordId: consentId,
      })
      .returning({ id: schema.parentChannels.id });
    const channelId = channel?.id;
    if (!channelId) {
      throw new Error('reenrolOnStart: parent_channels insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'channel_sms_enrolled',
      targetTable: 'parent_channels',
      targetId: channelId,
      after: {
        kind: 'sms',
        maskedPhone: maskPhoneE164(input.phoneE164),
        verification: 'casl_start_keyword',
      },
    });
  });
}

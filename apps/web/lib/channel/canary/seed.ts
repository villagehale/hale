import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { SMS_CONSENT_SCOPE } from '~/lib/channels/sms-consent-copy';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { CANARY_PHONE_E164 } from './config';

/**
 * The canary's household — DATA, not schema, written ONCE against production.
 *
 * One families row, one users row, one primary_parent membership, and one ACTIVE
 * VERIFIED sms channel for CANARY_PHONE_E164 carrying its CASL consent record.
 * No children, no province, no email (users.email is nullable exactly for an
 * SMS-provisioned parent), onboarding stage left at its 'pending_invite'
 * default: the nudge, intro and follow-up sweeps all gate on stage 'sms_active',
 * which this household never reaches, and the week-plan sweep gates on the probe
 * channel itself (loop/cron.ts selectFamiliesToCompose). Sunday-send is the one
 * that matches on none of it — role, prefs and the local send moment only, so it
 * DOES select this parent; what stops it is one layer on, and worth naming
 * because it is a chain rather than a gate: nothing composed means no week-plan
 * artifact, `readPlan` returns null, and the run skips with `skippedNoPlan`
 * (loop/send.ts). The inbound reply path reads none of that, which is why the
 * turn the canary exists to exercise is unaffected.
 *
 * ONE TRANSACTION, because a verified SMS channel is never just a row: every
 * production path that creates one (sms-consent-core's enrolVerifiedChannel,
 * intake provision, the join and caregiver invites) writes the consent record,
 * points the channel at it, and writes the audit row together. `consent_record_id`
 * is nullable, so a hand-rolled insert would silently produce a verified channel
 * with no consent behind it and no audit trace of who made it — rules #1 and #6,
 * on the one household a script puts on the prod roster. Atomicity is the second
 * half of the same argument: a half-written run leaves orphans that the
 * blind-index probe below cannot see, and the re-run creates a SECOND canary.
 */

export type SeedCanaryResult =
  | { status: 'created'; familyId: string }
  | { status: 'already_seeded'; familyId: string }
  /** The channel exists but cannot route — never verified, or revoked. Named
   * rather than repaired: the canary claims nothing in this state while the cron
   * keeps injecting, and "it ran without error" must never mean that. */
  | { status: 'inactive'; familyId: string };

export async function seedCanaryHousehold(database: Database): Promise<SeedCanaryResult> {
  const phoneHash = phoneBlindIndex(CANARY_PHONE_E164);

  const [existing] = await database
    .select({
      familyId: schema.parentChannels.familyId,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneHash))
    .limit(1);

  if (existing) {
    return !existing.verifiedAt || existing.revokedAt !== null
      ? { status: 'inactive', familyId: existing.familyId }
      : { status: 'already_seeded', familyId: existing.familyId };
  }

  return database.transaction(async (tx) => {
    const one = <T>(rows: T[], what: string): T => {
      const row = rows[0];
      if (!row) throw new Error(`seedCanaryHousehold: insert returned no row for ${what}`);
      return row;
    };

    const family = one(
      await tx
        .insert(schema.families)
        .values({ displayName: 'Hale inbound canary' })
        .returning({ id: schema.families.id }),
      'family',
    );
    const user = one(
      await tx.insert(schema.users).values({ name: 'Canary' }).returning({ id: schema.users.id }),
      'user',
    );
    await tx.insert(schema.familyMembers).values({
      familyId: family.id,
      userId: user.id,
      role: 'primary_parent',
    });

    const consent = one(
      await tx
        .insert(schema.consentRecords)
        .values({
          userId: user.id,
          familyId: family.id,
          consentType: 'sms_service_messages',
          granted: true,
          consentScope: SMS_CONSENT_SCOPE,
          policyVersion: POLICY_VERSION,
        })
        .returning({ id: schema.consentRecords.id }),
      'consent',
    );

    const channel = one(
      await tx
        .insert(schema.parentChannels)
        .values({
          userId: user.id,
          familyId: family.id,
          kind: 'sms',
          phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
          phoneE164Hash: phoneHash,
          verifiedAt: new Date(),
          consentRecordId: consent.id,
        })
        .returning({ id: schema.parentChannels.id }),
      'channel',
    );

    await tx.insert(schema.auditLog).values({
      familyId: family.id,
      actor: user.id,
      actionTaken: 'channel_sms_enrolled',
      targetTable: 'parent_channels',
      targetId: channel.id,
      after: { kind: 'sms', maskedPhone: maskPhoneE164(CANARY_PHONE_E164) },
    });

    return { status: 'created', familyId: family.id };
  });
}

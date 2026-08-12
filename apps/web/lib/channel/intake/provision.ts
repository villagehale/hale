import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { encryptString } from '~/lib/crypto/string-cipher';
import { INTAKE_COUNTRY, type PostalContext, deriveDateOfBirth, intakeFamilyName } from './derive';
import type { AgePrecision } from './extract';
import type { TranscriptEntry } from './session';

/**
 * VIL-237 · M2 — provisioning a family from a text conversation. Mirrors
 * completeOnboarding's ONE-TRANSACTION discipline: the user, the family, the
 * children (their PII), the verified channel, the CASL consent, and the audit rows
 * commit together or not at all, so a crash can never leave a child's data in the
 * database without the consent row that authorises holding it (rule #1, rule #6).
 *
 * What differs from the web path, and why:
 *
 * - `users.email` is NULL. There is no address — the phone number IS the account.
 * - `external_auth_id` is `sms:<blind-index>`. The raw number appears NOWHERE in
 *   plaintext: not in the identity column, not in the audit rows (which carry only the
 *   masked form), not in logs. The hash is the same keyed blind index parent_channels
 *   resolves inbound `From` against, so the account and the channel agree by
 *   construction.
 * - `verified_at` is set immediately, WITHOUT an OTP. The web flow texts a code to
 *   prove the person typing owns the number; here the message ORIGINATED from the
 *   number — possession is proven by the fact of the inbound itself, which is strictly
 *   stronger evidence than echoing back a code we just sent. Sending an OTP would be
 *   asking someone to prove they hold the phone they are texting us from.
 * - Children carry `dob_precision = 'derived'`: the parent gave an age, not a date.
 */

const CHANNEL_KIND = 'sms';
/** The CASL basis recorded on the channel consent: the parent texted US first. */
export const INTAKE_CONSENT_SCOPE = 'sms_intake_origination';

/**
 * Where the family is, as established during intake — the same shape whichever of the
 * three routes established it: a full Canadian postal code, a bare FSA (D2), or a QR
 * venue whose OWN coarse area we know. Only the first carries a `postalCode`; all
 * three are Canadian by construction (the region gate runs in the caller), so
 * provisioning never guesses a country.
 */
export type IntakeLocation = PostalContext;

/**
 * A child provisioning is allowed to write. The age is NON-NULL, and that is the
 * point: the caller has to have an age before it can build one of these, so there is
 * no branch in here that could invent a date for a child we were never told the age
 * of. The gate lives in the state machine (`withKnownAges`), and the type is what
 * keeps it from being forgotten.
 */
export interface ProvisionChild {
  name: string | null;
  ageMonths: number;
  agePrecision: AgePrecision;
}

export interface ProvisionInput {
  phoneE164: string;
  phoneHash: string;
  children: readonly ProvisionChild[];
  location: IntakeLocation;
  sourceCode: string | null;
  /** The parent's first message, stored as the consent's evidence. */
  firstMessage: string;
  transcript: readonly TranscriptEntry[];
  now: Date;
}

export interface ProvisionResult {
  familyId: string;
  userId: string;
  channelId: string;
}

/**
 * The users row for this number, created if absent. Local rather than
 * `ensureUserRow` because that path requires an email address to mirror and maps a
 * duplicate address to EmailInUseError — neither of which exists here.
 */
async function ensureIntakeUser(tx: Database, externalAuthId: string): Promise<string> {
  await tx
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null })
    .onConflictDoNothing({ target: schema.users.externalAuthId });

  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);
  if (!row) {
    throw new Error('ensureIntakeUser: no users row after upsert');
  }
  return row.id;
}

export async function provisionFromIntake(
  database: Database,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const { phoneE164, phoneHash, location, now } = input;
  const externalAuthId = `sms:${phoneHash}`;

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const userId = await ensureIntakeUser(tx, externalAuthId);

    const [family] = await tx
      .insert(schema.families)
      .values({
        displayName: intakeFamilyName(input.children),
        // Provisioned into 'sms_intake', NOT 'sms_active': the watch-offer has not
        // been answered yet, and the stage is what records that.
        onboardingStage: 'sms_intake',
        country: INTAKE_COUNTRY,
        postalCode: location.postalCode,
        areaCoarse: location.areaCoarse,
      })
      .returning({ id: schema.families.id });
    const familyId = family?.id;
    if (!familyId) {
      throw new Error('provisionFromIntake: families insert returned no row');
    }

    await tx.insert(schema.familyMembers).values({ familyId, userId, role: 'primary_parent' });

    // The loop's exchange channel for a parent who arrived by TEXT is text. Without a
    // row the loop falls back to its documented default of 'email', and this parent has
    // no email address (see the module note) — so the default would address the loop to
    // a column that is NULL by construction. Everything else stays on the table's own
    // defaults, which are the same ones a web parent gets.
    await tx
      .insert(schema.loopPrefs)
      .values({ userId, loopChannel: 'sms' })
      .onConflictDoNothing({ target: schema.loopPrefs.userId });

    const childRows = input.children.map((child) => ({
      familyId,
      name: child.name?.trim() || 'your child',
      dateOfBirth: deriveDateOfBirth(child.ageMonths, child.agePrecision, now),
      dobPrecision: 'derived',
    }));
    if (childRows.length > 0) {
      await tx.insert(schema.children).values(childRows);
    }

    // The CASL record for the channel itself. `evidence` carries the parent's own
    // first message: the basis is that THEY initiated contact, so the artifact has to
    // hold the message that did it, not just an assertion that one existed.
    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId,
        familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: INTAKE_CONSENT_SCOPE,
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.firstMessage,
          interpretation: 'parent originated contact by texting Hale',
          sourceCode: input.sourceCode,
        },
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consent?.id;
    if (!consentId) {
      throw new Error('provisionFromIntake: consent insert returned no row');
    }

    const [channel] = await tx
      .insert(schema.parentChannels)
      .values({
        userId,
        familyId,
        kind: CHANNEL_KIND,
        phoneE164Encrypted: encryptString(phoneE164),
        phoneE164Hash: phoneHash,
        verifiedAt: now,
        consentRecordId: consentId,
      })
      .returning({ id: schema.parentChannels.id });
    const channelId = channel?.id;
    if (!channelId) {
      throw new Error('provisionFromIntake: parent_channels insert returned no row');
    }

    // The intake transcript, replayed now that there is a family for it to belong to.
    // channel_messages.family_id / parent_user_id are NOT NULL, so these rows could
    // not have been written as the conversation happened; until this moment the
    // record lived encrypted on the intake session.
    //
    // The replayed status is what we KNOW, which is less than it looks. An inbound is
    // 'delivered' because we are holding it. An outbound is only 'queued': it was handed
    // to the provider, and any receipt that came back while the family did not yet exist
    // resolved `unknown_message` and could not be applied to a row that wasn't there.
    // Writing 'sent' asserted carrier acceptance nobody ever observed — and 'sent' is one
    // of the statuses the funnel scoreboard counts as having reached the parent, so a
    // carrier filtering every greeting read as a carrier delivering every greeting. Late
    // receipts still land: 'queued' is overwritable by sent/delivered/failed alike.
    for (const entry of input.transcript) {
      await tx.insert(schema.channelMessages).values({
        familyId,
        parentUserId: userId,
        channel: CHANNEL_KIND,
        direction: entry.direction,
        category: 'intake',
        providerMessageId: entry.providerId,
        status: entry.direction === 'in' ? 'delivered' : 'queued',
        // Verbatim bodies are stored for INBOUND only, matching the ledger's rule:
        // an outbound is reconstructable from the copy module, and storing rendered
        // child data is a liability (rule #1).
        body: entry.direction === 'in' ? entry.body : null,
        sentAt: new Date(entry.at),
      });
    }

    await tx.insert(schema.auditLog).values([
      {
        familyId,
        actor: userId,
        actionTaken: 'family_created',
        targetTable: 'families',
        targetId: familyId,
      },
      {
        familyId,
        actor: userId,
        actionTaken: 'sms_intake_provisioned',
        targetTable: 'families',
        targetId: familyId,
        after: {
          childCount: childRows.length,
          areaCoarse: location.areaCoarse,
          sourceCode: input.sourceCode,
          maskedPhone: maskPhoneE164(phoneE164),
        },
      },
      {
        familyId,
        actor: userId,
        actionTaken: 'channel_sms_enrolled',
        targetTable: 'parent_channels',
        targetId: channelId,
        after: {
          kind: CHANNEL_KIND,
          maskedPhone: maskPhoneE164(phoneE164),
          verification: 'inbound_origination',
        },
      },
    ]);

    return { familyId, userId, channelId };
  });
}

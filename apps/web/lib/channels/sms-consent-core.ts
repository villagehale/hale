import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { SMS_CONSENT_SCOPE } from './sms-consent-copy';
import type { OtpSender } from './otp-sender';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  isOtpLockedOut,
  isResendInCooldown,
  verifyOtpCode,
} from './otp';
import { maskPhoneE164, normalizePhoneE164 } from './phone';

/**
 * The SMS channel enrolment engine (VIL-212). Pure of auth/request concerns — every
 * function takes a Database handle + explicit params + injected deps, so the logic
 * (OTP lifecycle, the verify→consent→channel→audit transaction, revocation) is
 * unit-testable against a fake db, mirroring lib/teen-access. The auth/ip wrapper
 * lives in ./sms-consent.
 *
 * We OWN the code (generate + hash + verify locally); the OtpSender only transmits
 * it. Consent is written directly in the enrol transaction (not via recordConsent)
 * to carry ip/userAgent and co-commit with the verify flip + audit. Per-PARENT — a
 * consent row is the parent's own, so the two-parent rule (#5) is not triggered.
 */

// The versioned CASL consent copy + scope live in ./sms-consent-copy (a
// dependency-free module the client Settings component also reads). Re-exported
// here so callers/tests get them from the engine module too.
export { SMS_CONSENT_COPY, SMS_CONSENT_COPY_VERSION, SMS_CONSENT_SCOPE } from './sms-consent-copy';

const CHANNEL_KIND = 'sms';

export interface SmsRequestDeps {
  sender: OtpSender;
  now?: Date;
  generateCode?: () => string;
}

export interface SmsMutationDeps {
  now?: Date;
}

/** Raised inside the enrol transaction when the code was already consumed (race). */
class OtpConsumedRaceError extends Error {}

export type RequestOtpResult =
  | { status: 'sent'; maskedPhone: string }
  | { status: 'not_configured' }
  | { status: 'invalid_phone' }
  | { status: 'cooldown'; retryAfterMs: number };

/**
 * Mint + send a fresh OTP for `phoneRaw`. Refuses an invalid NANP number, honours
 * the 60s resend cooldown, and persists NOTHING when the sender is unconfigured
 * (the honest "SMS not launched yet" state — no phantom pending code). On send it
 * invalidates the user's prior unconsumed codes and stores the new code HASHED and
 * the phone ENCRYPTED, both in one transaction.
 */
export async function requestPhoneOtp(
  database: Database,
  input: { userId: string; phoneRaw: string },
  deps: SmsRequestDeps,
): Promise<RequestOtpResult> {
  const now = deps.now ?? new Date();
  const phoneE164 = normalizePhoneE164(input.phoneRaw);
  if (!phoneE164) {
    return { status: 'invalid_phone' };
  }

  const [recent] = await database
    .select({ lastSentAt: schema.phoneVerifications.lastSentAt })
    .from(schema.phoneVerifications)
    .where(
      and(
        eq(schema.phoneVerifications.userId, input.userId),
        isNull(schema.phoneVerifications.consumedAt),
      ),
    )
    .orderBy(desc(schema.phoneVerifications.lastSentAt))
    .limit(1);

  if (recent?.lastSentAt && isResendInCooldown(recent.lastSentAt, now)) {
    return {
      status: 'cooldown',
      retryAfterMs: OTP_RESEND_COOLDOWN_MS - (now.getTime() - recent.lastSentAt.getTime()),
    };
  }

  const code = (deps.generateCode ?? generateOtpCode)();
  const send = await deps.sender.sendCode({ phoneE164, code });
  if (send.status === 'not_configured') {
    return { status: 'not_configured' };
  }

  await database.transaction(async (tx) => {
    // Only the newest code works — invalidate any prior unconsumed one first.
    await tx
      .update(schema.phoneVerifications)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.phoneVerifications.userId, input.userId),
          isNull(schema.phoneVerifications.consumedAt),
        ),
      );

    await tx.insert(schema.phoneVerifications).values({
      userId: input.userId,
      phoneE164Encrypted: encryptString(phoneE164),
      codeHash: hashOtpCode(code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      lastSentAt: now,
    });
  });

  return { status: 'sent', maskedPhone: maskPhoneE164(phoneE164) };
}

export type VerifyOtpResult =
  | { status: 'verified'; maskedPhone: string }
  | { status: 'wrong_code'; attemptsRemaining: number }
  | { status: 'locked' }
  | { status: 'expired' }
  | { status: 'no_pending' };

/**
 * Check a submitted code against the user's newest pending verification. A wrong
 * guess increments the attempt counter (locking at the ceiling); an expired or
 * locked code is refused. On the right code, enrols the channel + CASL consent +
 * audit atomically (see {@link enrolVerifiedChannel}).
 */
export async function verifyPhoneOtp(
  database: Database,
  input: { userId: string; familyId: string; code: string; ip?: string; userAgent?: string },
  deps: SmsRequestDeps,
): Promise<VerifyOtpResult> {
  const now = deps.now ?? new Date();

  const [pending] = await database
    .select({
      id: schema.phoneVerifications.id,
      phoneE164Encrypted: schema.phoneVerifications.phoneE164Encrypted,
      codeHash: schema.phoneVerifications.codeHash,
      expiresAt: schema.phoneVerifications.expiresAt,
      attemptCount: schema.phoneVerifications.attemptCount,
    })
    .from(schema.phoneVerifications)
    .where(
      and(
        eq(schema.phoneVerifications.userId, input.userId),
        isNull(schema.phoneVerifications.consumedAt),
      ),
    )
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);

  if (!pending) {
    return { status: 'no_pending' };
  }
  if (isOtpLockedOut(pending.attemptCount)) {
    return { status: 'locked' };
  }
  if (isOtpExpired(pending.expiresAt, now)) {
    return { status: 'expired' };
  }

  if (!verifyOtpCode(input.code, pending.codeHash)) {
    const attemptCount = pending.attemptCount + 1;
    await database
      .update(schema.phoneVerifications)
      .set({ attemptCount })
      .where(eq(schema.phoneVerifications.id, pending.id));
    return isOtpLockedOut(attemptCount)
      ? { status: 'locked' }
      : { status: 'wrong_code', attemptsRemaining: OTP_MAX_ATTEMPTS - attemptCount };
  }

  const phoneE164 = decryptString(pending.phoneE164Encrypted);
  try {
    await enrolVerifiedChannel(database, {
      userId: input.userId,
      familyId: input.familyId,
      verificationId: pending.id,
      phoneE164,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
  } catch (err) {
    if (err instanceof OtpConsumedRaceError) {
      return { status: 'no_pending' };
    }
    throw err;
  }

  return { status: 'verified', maskedPhone: maskPhoneE164(phoneE164) };
}

/**
 * The atomic verify→enrol transaction (rule #6). In one tx: burn the code (single
 * use, conditional), soft-revoke any prior active channel (kept for audit), write
 * the CASL consent row (granted, with ip/userAgent + the consent-copy version),
 * write the verified channel carrying that consent id, and write the immutable
 * audit row. The audit carries only the MASKED phone — never the raw number.
 */
async function enrolVerifiedChannel(
  database: Database,
  params: {
    userId: string;
    familyId: string;
    verificationId: string;
    phoneE164: string;
    ip?: string;
    userAgent?: string;
    now: Date;
  },
): Promise<{ channelId: string; consentId: string }> {
  const { userId, familyId, phoneE164, now } = params;
  const phoneHash = phoneBlindIndex(phoneE164);

  return database.transaction(async (tx) => {
    const burned = await tx
      .update(schema.phoneVerifications)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.phoneVerifications.id, params.verificationId),
          isNull(schema.phoneVerifications.consumedAt),
        ),
      )
      .returning({ id: schema.phoneVerifications.id });
    if (!burned[0]) {
      throw new OtpConsumedRaceError();
    }

    // Revoke-then-insert: a re-enrol / number change keeps the prior active row as
    // soft-revoked history while the partial unique index bars two active channels.
    // Also supersede any OTHER parent's active claim on the SAME number — the person
    // who just proved control of it (via the OTP) is now its owner — so the
    // phone-hash active-uniqueness holds and the inbound lookup resolves to them.
    await tx
      .update(schema.parentChannels)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          isNull(schema.parentChannels.revokedAt),
          or(
            and(
              eq(schema.parentChannels.userId, userId),
              eq(schema.parentChannels.kind, CHANNEL_KIND),
            ),
            eq(schema.parentChannels.phoneE164Hash, phoneHash),
          ),
        ),
      );

    const consentInserted = await tx
      .insert(schema.consentRecords)
      .values({
        userId,
        familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: SMS_CONSENT_SCOPE,
        policyVersion: POLICY_VERSION,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consentInserted[0]?.id;
    if (!consentId) {
      throw new Error('enrolVerifiedChannel: consent insert returned no row');
    }

    const channelInserted = await tx
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
    const channelId = channelInserted[0]?.id;
    if (!channelId) {
      throw new Error('enrolVerifiedChannel: channel insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'channel_sms_enrolled',
      targetTable: 'parent_channels',
      targetId: channelId,
      after: { kind: CHANNEL_KIND, maskedPhone: maskPhoneE164(phoneE164) },
    });

    return { channelId, consentId };
  });
}

export type RevokeChannelResult = { status: 'revoked' } | { status: 'not_found' };

/**
 * Mechanical revocation (in-app toggle; STOP handled at the inbound seam later). In
 * one tx: soft-revoke the active channel, record a consent WITHDRAWAL (granted=false,
 * with ip/userAgent), and write the audit row. Re-enrolment requires re-verifying.
 */
export async function revokeSmsChannel(
  database: Database,
  input: { userId: string; familyId: string; ip?: string; userAgent?: string },
  deps: SmsMutationDeps = {},
): Promise<RevokeChannelResult> {
  const now = deps.now ?? new Date();

  const [active] = await database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.userId, input.userId),
        eq(schema.parentChannels.kind, CHANNEL_KIND),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);

  if (!active) {
    return { status: 'not_found' };
  }

  await database.transaction(async (tx) => {
    await tx
      .update(schema.parentChannels)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(schema.parentChannels.id, active.id));

    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'sms_service_messages',
      granted: false,
      consentScope: SMS_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'channel_sms_revoked',
      targetTable: 'parent_channels',
      targetId: active.id,
      after: { revoked: true },
    });
  });

  return { status: 'revoked' };
}

export interface SmsChannelState {
  enrolled: boolean;
  maskedPhone: string | null;
  verifiedAt: Date | null;
}

/**
 * The parent's current active, verified SMS channel (if any), for the Settings
 * read. Decrypts the stored number only to mask it — the raw value never leaves
 * this function.
 */
export async function loadSmsChannelState(
  database: Database,
  userId: string,
): Promise<SmsChannelState> {
  const [active] = await database
    .select({
      phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted,
      verifiedAt: schema.parentChannels.verifiedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.userId, userId),
        eq(schema.parentChannels.kind, CHANNEL_KIND),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);

  if (!active?.verifiedAt) {
    return { enrolled: false, maskedPhone: null, verifiedAt: null };
  }
  return {
    enrolled: true,
    maskedPhone: maskPhoneE164(decryptString(active.phoneE164Encrypted)),
    verifiedAt: active.verifiedAt,
  };
}

export interface ResolvedChannel {
  userId: string;
  familyId: string;
  channelId: string;
}

/**
 * Resolve an inbound number to its ACTIVE, verified channel owner — the contract the
 * inbound-SMS webhook (A3) uses to route a reply to a parent. Looks up by the blind
 * index (the raw number is never stored, so equality search goes through the hash),
 * scoped to `verified_at IS NOT NULL AND revoked_at IS NULL`; the partial unique index
 * guarantees at most one such row per number, so a recycled number's revoked history
 * is ignored. The `From` is run through the SAME canonical normalizer enrolment uses,
 * so a differently-formatted-but-equal number still matches. Returns null when there
 * is no active verified channel (never enrolled, unverified, revoked, or malformed).
 */
export async function resolveVerifiedChannelByPhone(
  database: Database,
  fromPhone: string,
): Promise<ResolvedChannel | null> {
  const canonical = normalizePhoneE164(fromPhone);
  if (!canonical) return null;

  const [row] = await database
    .select({
      userId: schema.parentChannels.userId,
      familyId: schema.parentChannels.familyId,
      id: schema.parentChannels.id,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(canonical)),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);

  // Defense in depth: only ever resolve a genuinely active, verified channel, even if
  // the query were to return otherwise — a revoked/unverified row must never route.
  if (!row || row.verifiedAt === null || row.revokedAt !== null) {
    return null;
  }
  return { userId: row.userId, familyId: row.familyId, channelId: row.id };
}

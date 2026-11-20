import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import { OTP_MAX_ATTEMPTS, isOtpExpired, isOtpLockedOut, verifyOtpCode } from '~/lib/channels/otp';
import type { OtpSender } from '~/lib/channels/otp-sender';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import {
  requestPhoneOtp,
  resolveVerifiedChannelByPhone,
} from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString } from '~/lib/crypto/string-cipher';
import { familyAlreadySubscribed } from './already-subscribed.js';

/**
 * Ads new-visitor founding join. Behind PROMO_NEW_VISITOR_CHECKOUT_ENABLED.
 *
 * Hale does not text first: the only outbound is the OTP the visitor asked for
 * (`otpMessage` — the one allowed piece of fixed copy). The family is pending
 * and has NO verified channel, so the first inbound still starts intake on the
 * already-paid household.
 *
 * Distinct outcomes are for the server log. The HTTP layer collapses them the
 * same way claim-by-phone does (rule #1).
 */

export function smsExternalAuthId(phoneHash: string): string {
  return `sms:${phoneHash}`;
}

export type PromoJoinRequestOutcome =
  | { status: 'sent' }
  | { status: 'invalid_phone' }
  | { status: 'stopped' }
  | { status: 'not_a_parent' }
  | { status: 'cooldown' }
  | { status: 'sender_not_configured' };

export type PromoJoinVerifyOutcome =
  | {
      status: 'ok';
      familyId: string;
      userId: string;
      externalAuthId: string;
      alreadyPaid: boolean;
    }
  | { status: 'refused'; reason: string };

async function ensureJoinUser(database: Database, externalAuthId: string): Promise<string> {
  await database
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null })
    .onConflictDoNothing({ target: schema.users.externalAuthId });
  const [row] = await database
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);
  if (!row) {
    throw new Error('ensureJoinUser: no users row after upsert');
  }
  return row.id;
}

async function numberIsStopped(database: Database, phoneE164: string): Promise<boolean> {
  const active = await resolveVerifiedChannelByPhone(database, phoneE164);
  if (active) return false;
  const hash = phoneBlindIndex(phoneE164);
  const [revoked] = await database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, hash),
        isNotNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(revoked);
}

async function membershipForUser(
  database: Database,
  userId: string,
): Promise<{ familyId: string; role: string } | null> {
  const [row] = await database
    .select({
      familyId: schema.familyMembers.familyId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Text a verification code to a number that asked for one on the founding CTA.
 * Does not create a family or a channel. A STOP'd number and a caregiver's
 * number get no SMS.
 */
export async function requestPromoJoinCode(
  database: Database,
  input: { phoneRaw: string; now?: Date },
  deps: { sender: OtpSender; generateCode?: () => string },
): Promise<PromoJoinRequestOutcome> {
  const phoneE164 = normalizePhoneE164(input.phoneRaw);
  if (!phoneE164) return { status: 'invalid_phone' };

  if (await numberIsStopped(database, phoneE164)) {
    return { status: 'stopped' };
  }

  const existing = await resolveVerifiedChannelByPhone(database, phoneE164);
  if (existing) {
    const membership = await membershipForUser(database, existing.userId);
    if (!membership || !isParentRole(membership.role)) {
      return { status: 'not_a_parent' };
    }
  }

  const phoneHash = phoneBlindIndex(phoneE164);
  const userId = await ensureJoinUser(database, smsExternalAuthId(phoneHash));
  const sent = await requestPhoneOtp(
    database,
    { userId, phoneRaw: phoneE164 },
    { sender: deps.sender, now: input.now, generateCode: deps.generateCode },
  );

  switch (sent.status) {
    case 'sent':
      return { status: 'sent' };
    case 'not_configured':
      return { status: 'sender_not_configured' };
    case 'cooldown':
      return { status: 'cooldown' };
    case 'invalid_phone':
      return { status: 'invalid_phone' };
  }
}

async function loadPendingCode(
  database: Database,
  userId: string,
): Promise<{
  id: string;
  phoneE164Encrypted: string;
  codeHash: string;
  expiresAt: Date;
  attemptCount: number;
} | null> {
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
        eq(schema.phoneVerifications.userId, userId),
        isNull(schema.phoneVerifications.consumedAt),
      ),
    )
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);
  return pending ?? null;
}

async function ensurePendingFamily(
  database: Database,
  input: { userId: string; now: Date },
): Promise<{ familyId: string; created: boolean }> {
  const membership = await membershipForUser(database, input.userId);
  if (membership?.familyId) {
    return { familyId: membership.familyId, created: false };
  }

  const created = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const raced = await membershipForUser(tx, input.userId);
    if (raced?.familyId) return { familyId: raced.familyId, created: false };

    const [family] = await tx
      .insert(schema.families)
      .values({
        displayName: 'Family',
        onboardingStage: 'pending_invite',
      })
      .returning({ id: schema.families.id });
    const familyId = family?.id;
    if (!familyId) {
      throw new Error('ensurePendingFamily: families insert returned no row');
    }
    await tx.insert(schema.familyMembers).values({
      familyId,
      userId: input.userId,
      role: 'primary_parent',
    });
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: input.userId,
      actionTaken: 'promo_join_family_created',
      targetTable: 'families',
      targetId: familyId,
      occurredAt: input.now,
    });
    return { familyId, created: true };
  });
  return created;
}

/**
 * Spend the OTP and attach (or reuse) a pending family. Never enrols a channel.
 */
export async function verifyPromoJoinCode(
  database: Database,
  input: { phoneRaw: string; code: string; now?: Date },
): Promise<PromoJoinVerifyOutcome> {
  const now = input.now ?? new Date();
  const refuse = (reason: string): PromoJoinVerifyOutcome => ({ status: 'refused', reason });

  const phoneE164 = normalizePhoneE164(input.phoneRaw);
  if (!phoneE164) return refuse('invalid_phone');

  if (await numberIsStopped(database, phoneE164)) {
    return refuse('stopped');
  }

  const existing = await resolveVerifiedChannelByPhone(database, phoneE164);
  if (existing) {
    const membership = await membershipForUser(database, existing.userId);
    if (!membership || !isParentRole(membership.role)) {
      return refuse('not_a_parent');
    }
  }

  const phoneHash = phoneBlindIndex(phoneE164);
  const externalAuthId = smsExternalAuthId(phoneHash);
  const [user] = await database
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);
  if (!user) return refuse('no_identity');

  const pending = await loadPendingCode(database, user.id);
  if (!pending) return refuse('no_pending_code');
  if (decryptString(pending.phoneE164Encrypted) !== phoneE164) {
    return refuse('code_not_for_this_number');
  }
  if (isOtpLockedOut(pending.attemptCount)) return refuse('locked');
  if (isOtpExpired(pending.expiresAt, now)) return refuse('expired');
  if (!verifyOtpCode(input.code, pending.codeHash)) {
    const attemptCount = pending.attemptCount + 1;
    await database
      .update(schema.phoneVerifications)
      .set({ attemptCount })
      .where(eq(schema.phoneVerifications.id, pending.id));
    return refuse(isOtpLockedOut(attemptCount) ? 'locked' : 'wrong_code');
  }

  const burned = await database
    .update(schema.phoneVerifications)
    .set({ consumedAt: now })
    .where(
      and(
        eq(schema.phoneVerifications.id, pending.id),
        isNull(schema.phoneVerifications.consumedAt),
      ),
    )
    .returning({ id: schema.phoneVerifications.id });
  if (!burned[0]) return refuse('no_pending_code');

  const family = await ensurePendingFamily(database, { userId: user.id, now });
  await database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: user.id,
    actionTaken: 'promo_join_verified',
    targetTable: 'phone_verifications',
    targetId: pending.id,
    occurredAt: now,
  });
  const [billing] = await database
    .select({
      planTier: schema.families.planTier,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, family.familyId))
    .limit(1);

  return {
    status: 'ok',
    familyId: family.familyId,
    userId: user.id,
    externalAuthId,
    alreadyPaid: billing ? familyAlreadySubscribed(billing) : false,
  };
}

export const PROMO_JOIN_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;

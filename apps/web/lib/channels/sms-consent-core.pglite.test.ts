import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { hashOtpCode } from './otp';
import { FakeOtpSender } from './otp-sender';
import { maskPhoneE164 } from './phone';
import { verifyPhoneOtp } from './sms-consent-core';

/**
 * VIL-310 · the web code is a door onto an active channel like START and intake, so it
 * keeps the same invariant: a number that owns an active channel has no open caregiver
 * invite. Against the real DDL, because the claim is which rows the invite lookup and
 * the active-phone unique index see — the chain fake in sms-consent-core.test.ts
 * answers every read with the same rows.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+12505550147';
const CODE = '428913';
const NOW = new Date('2026-10-01T08:30:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedParentWithPendingCode(): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'BC' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'web:verifying-parent' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.phoneVerifications).values({
    userId,
    phoneE164Encrypted: encryptString(PHONE),
    codeHash: hashOtpCode(CODE),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    lastSentAt: NOW,
    createdAt: NOW,
  });
  return { familyId, userId };
}

async function seedOpenInviteFromAnotherFamily(): Promise<string> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Other household', provinceOrState: 'BC' })
    .returning({ id: schema.families.id });
  const [inviter] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:the-inviting-parent' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const invitedByUserId = inviter?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: invitedByUserId, role: 'primary_parent' });
  const [invite] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId,
      invitedByUserId,
      role: 'grandparent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  return invite?.id as string;
}

function activeChannels() {
  return db.database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(PHONE)),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
}

function inviteAudit() {
  return db.database
    .select({ actionTaken: schema.auditLog.actionTaken, targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetTable, 'caregiver_invites'));
}

describe('verifyPhoneOtp — the right code closes the invite in flight on the same number', () => {
  it('closes it as superseded_by_enrollment, with exactly one active channel', async () => {
    const { familyId, userId } = await seedParentWithPendingCode();
    const inviteId = await seedOpenInviteFromAnotherFamily();

    const result = await verifyPhoneOtp(
      db.database,
      { userId, familyId, code: CODE },
      { sender: new FakeOtpSender(), now: NOW },
    );

    expect(result).toEqual({ status: 'verified', maskedPhone: maskPhoneE164(PHONE) });
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite).toEqual({ state: 'superseded_by_enrollment', closedAt: NOW });
    expect(await activeChannels()).toHaveLength(1);
    expect(await inviteAudit()).toEqual([
      { actionTaken: 'caregiver_invite_superseded_by_enrollment', targetId: inviteId },
    ]);
  });

  it('positive control: with no invite in flight, the ordinary verified result', async () => {
    const { familyId, userId } = await seedParentWithPendingCode();

    const result = await verifyPhoneOtp(
      db.database,
      { userId, familyId, code: CODE },
      { sender: new FakeOtpSender(), now: NOW },
    );

    expect(result).toEqual({ status: 'verified', maskedPhone: maskPhoneE164(PHONE) });
    expect(await activeChannels()).toHaveLength(1);
    expect(await inviteAudit()).toEqual([]);
  });
});

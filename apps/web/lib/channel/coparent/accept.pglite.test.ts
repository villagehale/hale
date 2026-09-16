import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CoParentInvite,
  supersedeOpenInviteOnEnrollment,
} from '~/lib/channel/caregiver/invites';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { CO_PARENT_INVITE_CONSENT_SCOPE, acceptCoParentInvite } from './accept';

/**
 * VIL-355 · the seating transaction against the REAL DDL.
 *
 * Everything this file asserts is a database promise the fake cannot make. The claim is
 * a conditional UPDATE re-tested against the locked row, the "nobody is seated twice"
 * is `parent_channels_phone_hash_active_idx`, and the all-or-nothing is a real rollback.
 * A fake would answer yes to all three with the guards deleted.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const NOW = new Date('2026-09-15T12:00:00.000Z');

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

let households = 0;

async function seedFamily(): Promise<{ familyId: string; parentUserId: string }> {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:household-${households}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

/** An invite already past the parent's yes — the row the invitee's reply arrives at. */
async function armedInvite(
  seeded: { familyId: string; parentUserId: string },
  role: 'co_parent' | 'grandparent' = 'co_parent',
): Promise<CoParentInvite> {
  const [row] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role,
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  return {
    id: row?.id as string,
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164: PARTNER_PHONE,
    state: 'awaiting_caregiver_reply',
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
  };
}

async function rows<T extends Record<string, unknown>>(select: () => Promise<T[]>): Promise<T[]> {
  return select();
}

function members(familyId: string) {
  return rows(() =>
    db.database
      .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId)),
  );
}

function consents() {
  return rows(() =>
    db.database
      .select({
        userId: schema.consentRecords.userId,
        consentType: schema.consentRecords.consentType,
        consentScope: schema.consentRecords.consentScope,
        granted: schema.consentRecords.granted,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords),
  );
}

function channels() {
  return rows(() =>
    db.database
      .select({
        userId: schema.parentChannels.userId,
        phoneE164Hash: schema.parentChannels.phoneE164Hash,
        verifiedAt: schema.parentChannels.verifiedAt,
      })
      .from(schema.parentChannels),
  );
}

async function auditVerbs(): Promise<string[]> {
  const found = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog);
  return found.map((r) => r.actionTaken);
}

describe('the invitee is seated', () => {
  it('writes their own consent, their channel, the membership and both audit rows', async () => {
    const seeded = await seedFamily();
    const invite = await armedInvite(seeded);

    const seated = await acceptCoParentInvite(db.database, {
      invite,
      verbatimReply: 'yes',
      now: NOW,
    });

    expect(seated?.coParentUserId).toBeTypeOf('string');
    expect(seated?.supersededInviteId).toBeNull();

    // THEIR OWN consent, from their own number, on the scope that says who started the
    // conversation. `sms_join_origination` would be a false record: Hale texted first.
    const theirConsent = (await consents()).filter((c) => c.userId === seated?.coParentUserId);
    expect(theirConsent).toEqual([
      expect.objectContaining({
        consentType: 'sms_service_messages',
        consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
        granted: true,
      }),
    ]);
    expect((theirConsent[0]?.evidence as Record<string, unknown>).verbatimReply).toBe('yes');

    expect(await members(seeded.familyId)).toEqual(
      expect.arrayContaining([{ userId: seated?.coParentUserId, role: 'co_parent' }]),
    );
    const theirChannel = (await channels()).filter(
      (c) => c.phoneE164Hash === phoneBlindIndex(PARTNER_PHONE),
    );
    expect(theirChannel).toHaveLength(1);
    // Verified by ORIGINATION: the acceptance arrived from the number, no OTP.
    expect(theirChannel[0]?.verifiedAt).toEqual(NOW);

    expect(await auditVerbs()).toEqual(
      expect.arrayContaining(['co_parent_invite_accepted', 'channel_sms_enrolled']),
    );
    // Never the caregiver twin: this person is the other parent of these children.
    expect(await auditVerbs()).not.toContain('caregiver_invite_accepted');
  });

  /**
   * Two phones, one forwarded thread, both saying yes. The claim is a conditional UPDATE
   * on `closed_at IS NULL` re-tested inside the transaction, so the loser matches nothing
   * and is handed back null — rather than reaching the channel insert and taking the
   * webhook down with a unique violation the carrier then retries.
   */
  it('seats exactly one on a second yes, and the index is why that matters', async () => {
    const seeded = await seedFamily();
    const invite = await armedInvite(seeded);

    const first = await acceptCoParentInvite(db.database, {
      invite,
      verbatimReply: 'yes',
      now: NOW,
    });
    const second = await acceptCoParentInvite(db.database, {
      invite,
      verbatimReply: 'yes please',
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(
      (await channels()).filter((c) => c.phoneE164Hash === phoneBlindIndex(PARTNER_PHONE)),
    ).toHaveLength(1);
    expect((await members(seeded.familyId)).filter((m) => m.role === 'co_parent')).toHaveLength(1);

    // THE POSITIVE CONTROL for the claim. Without it the second acceptance would run to
    // the channel insert, and this is the 500 it would raise there.
    const [nobody] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:nobody' })
      .returning({ id: schema.users.id });
    await expect(
      db.database.insert(schema.parentChannels).values({
        userId: nobody?.id as string,
        familyId: seeded.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(PARTNER_PHONE),
        phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
        verifiedAt: NOW,
      }),
    ).rejects.toThrow(/parent_channels_phone_hash_active_idx/);
  });

  /**
   * ALL OR NOTHING. The number enrolled somewhere else between the parent's yes and the
   * invitee's, so the channel insert raises — and everything the transaction had already
   * written has to go with it. The consent row is written BEFORE the channel, which is
   * exactly why its absence afterwards is the proof: a consent row that outlived the
   * failure would be a record of an agreement that never seated anyone.
   */
  it('leaves neither the claim, the consent nor the membership when the channel fails', async () => {
    const seeded = await seedFamily();
    const invite = await armedInvite(seeded);
    const [stranger] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:enrolled-elsewhere' })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.parentChannels).values({
      userId: stranger?.id as string,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      verifiedAt: NOW,
    });

    await expect(
      acceptCoParentInvite(db.database, { invite, verbatimReply: 'yes', now: NOW }),
    ).rejects.toThrow(/parent_channels_phone_hash_active_idx/);

    expect(await consents()).toHaveLength(0);
    expect((await members(seeded.familyId)).filter((m) => m.role === 'co_parent')).toHaveLength(0);
    const [after] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, invite.id));
    expect(after).toEqual({ state: 'awaiting_caregiver_reply', closedAt: null });
  });
});

describe('the other door', () => {
  /**
   * The join link (VIL-297) stays, so the same person can arrive through both. Whichever
   * seats them closes the other, and the trail has to name the invite that actually
   * closed — the landmine: `supersedeOpenInviteOnEnrollment` wrote the caregiver verb
   * unconditionally, so the row said "a caregiver invite" about a co-parent.
   */
  it('closes a co-parent invite under the CO-PARENT verb', async () => {
    const seeded = await seedFamily();
    const invite = await armedInvite(seeded);

    expect(
      await supersedeOpenInviteOnEnrollment(db.database, {
        phoneE164: PARTNER_PHONE,
        via: 'co_parent_join',
        now: NOW,
      }),
    ).toBe(invite.id);
    expect(await auditVerbs()).toEqual(['co_parent_invite_superseded_by_join']);
  });

  /** The positive control for the branch above: the same door, the same call, and the
   * caregiver's own verb — so the test proves a discrimination rather than a constant. */
  it('closes a caregiver invite under the caregiver verb', async () => {
    const seeded = await seedFamily();
    await armedInvite(seeded, 'grandparent');

    await supersedeOpenInviteOnEnrollment(db.database, {
      phoneE164: PARTNER_PHONE,
      via: 'co_parent_join',
      now: NOW,
    });
    expect(await auditVerbs()).toEqual(['caregiver_invite_superseded_by_join']);
  });
});

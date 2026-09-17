import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoParentInvite } from '~/lib/channel/caregiver/invites';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { POLICY_VERSION } from '~/lib/consent';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { CO_PARENT_INVITE_CONSENT_SCOPE, acceptCoParentInvite } from './accept';
import { departCoParent } from './depart';

/**
 * VIL-355 · departure against the REAL DDL, because every promise it makes is a
 * database one: the seat is claimed by a conditional DELETE, the channel by the
 * partial active index, and "the household's record is untouched" is only true of a
 * transaction that never names those tables.
 *
 * The household rows are seeded and re-read row for row. An identity assertion alone
 * is green on a function that does nothing, so every one of them is PAIRED with an
 * assertion that the actor's own rows did change.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_PHONE = '+16475550111';
/** One number per household, on BOTH sides: `parent_channels_phone_hash_active_idx` is
 * global, so two seated parents sharing a number could not both exist — a second
 * household seeded with the first one's number dies on the index, not on the code. */
const parentPhone = (household: number) => `+1416555${1000 + household}`;
const partnerPhone = (household: number) => `+1647555${2000 + household}`;
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DEPARTED_AT = new Date('2026-10-01T08:30:00.000Z');

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

interface Household {
  familyId: string;
  parentUserId: string;
  coParentUserId: string;
  partnerPhone: string;
}

/** A household that went all the way through the real seating transaction: the
 * co-parent's consent row, channel and seat are the ones acceptance actually writes. */
async function seedSeatedHousehold(): Promise<Household> {
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
    phoneE164Encrypted: encryptString(parentPhone(households)),
    phoneE164Hash: phoneBlindIndex(parentPhone(households)),
    verifiedAt: NOW,
  });

  const phoneE164 = partnerPhone(households);
  const [row] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId,
      invitedByUserId: parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(phoneE164),
      phoneE164Hash: phoneBlindIndex(phoneE164),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  const invite: CoParentInvite = {
    id: row?.id as string,
    familyId,
    invitedByUserId: parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164,
    state: 'awaiting_caregiver_reply',
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
  };
  const seated = await acceptCoParentInvite(db.database, {
    invite,
    verbatimReply: 'yes',
    now: NOW,
  });
  if (seated.outcome !== 'seated') {
    throw new Error(`seedSeatedHousehold: acceptance returned ${seated.outcome}`);
  }
  return { familyId, parentUserId, coParentUserId: seated.coParentUserId, partnerPhone: phoneE164 };
}

/** What the HOUSEHOLD owns, which a departure may not touch: the family's facts, the
 * departing parent's own long-lived thread, and an invite the other parent has out. */
async function seedHouseholdRecord(household: Household): Promise<{ openInviteId: string }> {
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId: household.familyId,
    factType: 'routine',
    factKey: 'bedtime',
    factValue: { at: '19:30' },
  });
  await db.database.insert(schema.conversations).values([
    { familyId: household.familyId, noteKey: channelSmsNoteKey(household.coParentUserId) },
    { familyId: household.familyId, noteKey: channelSmsNoteKey(household.parentUserId) },
  ]);
  const [open] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId: household.familyId,
      invitedByUserId: household.parentUserId,
      role: 'grandparent',
      displayName: 'Rosa',
      phoneE164Encrypted: encryptString(OTHER_PHONE),
      phoneE164Hash: phoneBlindIndex(OTHER_PHONE),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  return { openInviteId: open?.id as string };
}

function facts(familyId: string) {
  return db.database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

function members(familyId: string) {
  return db.database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
}

function channelsOf(userId: string) {
  return db.database
    .select({
      id: schema.parentChannels.id,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, userId));
}

function consentsOf(userId: string) {
  return db.database
    .select({
      consentType: schema.consentRecords.consentType,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
    })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.userId, userId))
    .orderBy(schema.consentRecords.grantedAt);
}

function threads(familyId: string) {
  return db.database
    .select({ id: schema.conversations.id, noteKey: schema.conversations.noteKey })
    .from(schema.conversations)
    .where(eq(schema.conversations.familyId, familyId));
}

function auditRows(familyId: string) {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      actionTaken: schema.auditLog.actionTaken,
      targetTable: schema.auditLog.targetTable,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('departCoParent — one actor leaves, the household keeps its record', () => {
  it('revokes the channel, removes the seat, withdraws the consent, and keeps the thread', async () => {
    const household = await seedSeatedHousehold();
    const { openInviteId } = await seedHouseholdRecord(household);
    const factsBefore = await facts(household.familyId);

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({
      outcome: 'departed',
      channelRevoked: 1,
      membershipRemoved: true,
      consentWithdrawn: 1,
      threadRetained: 1,
    });

    // THE ACTOR'S OWN ROWS CHANGED — the positive control every identity assertion
    // below leans on.
    const coParentChannels = await channelsOf(household.coParentUserId);
    expect(coParentChannels).toHaveLength(1);
    expect(coParentChannels[0]?.revokedAt).toEqual(DEPARTED_AT);
    expect(await members(household.familyId)).toEqual([
      { userId: household.parentUserId, role: 'primary_parent' },
    ]);
    const coParentConsents = await consentsOf(household.coParentUserId);
    expect(coParentConsents).toEqual([
      {
        consentType: 'sms_service_messages',
        consentScope: 'sms_coparent_invite_reply',
        granted: true,
      },
      {
        consentType: 'sms_service_messages',
        consentScope: 'sms_coparent_invite_reply',
        granted: false,
      },
    ]);

    // THE HOUSEHOLD'S OWN ROWS DID NOT.
    expect(await facts(household.familyId)).toEqual(factsBefore);
    expect((await threads(household.familyId)).map((t) => t.noteKey).sort()).toEqual(
      [
        channelSmsNoteKey(household.coParentUserId),
        channelSmsNoteKey(household.parentUserId),
      ].sort(),
    );
    const inviterChannels = await channelsOf(household.parentUserId);
    expect(inviterChannels).toHaveLength(1);
    expect(inviterChannels[0]?.revokedAt).toBeNull();
    expect(await consentsOf(household.parentUserId)).toEqual([]);
    const [stillOpen] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, openInviteId));
    expect(stillOpen).toEqual({ state: 'awaiting_caregiver_reply', closedAt: null });
  });

  it('writes one audit row per effect, actored by the person leaving, with no number in it', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    await db.database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.familyId, household.familyId));

    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    const rows = await auditRows(household.familyId);
    expect(rows.map((r) => r.actionTaken).sort()).toEqual([
      'channel_sms_revoked',
      'co_parent_access_withdrawn',
      'co_parent_departed',
    ]);
    for (const row of rows) {
      expect(row.actor).toBe(household.coParentUserId);
      // Not even masked: the departure rows say what was undone, never who. The digits
      // are the real seeded number, so this fails on any leak rather than on a literal
      // nobody writes.
      expect(JSON.stringify(row.after ?? {})).not.toContain(household.partnerPhone.slice(-4));
      expect(JSON.stringify(row.after ?? {})).not.toContain('Sam');
    }
  });

  it('refuses the primary parent — their door is the family sweep, and nothing is written', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const consentsBefore = await consentsOf(household.parentUserId);

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.parentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_departable', role: 'primary_parent' });
    expect((await members(household.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'primary_parent',
    ]);
    const inviterChannels = await channelsOf(household.parentUserId);
    expect(inviterChannels[0]?.revokedAt).toBeNull();
    expect(await consentsOf(household.parentUserId)).toEqual(consentsBefore);
    expect((await auditRows(household.familyId)).map((r) => r.actionTaken)).not.toContain(
      'co_parent_departed',
    );
  });

  it('is idempotent: a second departure finds no seat and writes nothing more', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });
    const consentsAfterFirst = await consentsOf(household.coParentUserId);
    const auditAfterFirst = await auditRows(household.familyId);

    const second = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: new Date(DEPARTED_AT.getTime() + 60_000),
    });

    expect(second).toEqual({ outcome: 'not_a_member' });
    expect(await consentsOf(household.coParentUserId)).toEqual(consentsAfterFirst);
    expect(await auditRows(household.familyId)).toEqual(auditAfterFirst);
  });

  /** They texted STOP weeks ago, and only now ask to be erased. Both effects are already
   * done, and the ledger must say so ONCE: a second `granted=false` row would make the
   * withdrawal look like it happened on the day they left, and re-stamping `revoked_at`
   * would move the date CASL is read against. The seat still goes. */
  it('does not re-revoke or re-withdraw what a STOP already closed, and still removes the seat', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const STOPPED_AT = new Date('2026-09-20T09:00:00.000Z');
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: STOPPED_AT })
      .where(eq(schema.parentChannels.userId, household.coParentUserId));
    await db.database.insert(schema.consentRecords).values({
      userId: household.coParentUserId,
      familyId: household.familyId,
      consentType: 'sms_service_messages',
      granted: false,
      consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      grantedAt: STOPPED_AT,
    });

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({
      outcome: 'departed',
      channelRevoked: 0,
      membershipRemoved: true,
      consentWithdrawn: 0,
      threadRetained: 1,
    });
    expect((await channelsOf(household.coParentUserId))[0]?.revokedAt).toEqual(STOPPED_AT);
    expect(await consentsOf(household.coParentUserId)).toHaveLength(2);
    expect(await members(household.familyId)).toEqual([
      { userId: household.parentUserId, role: 'primary_parent' },
    ]);
    expect((await auditRows(household.familyId)).map((r) => r.actionTaken)).toContain(
      'co_parent_departed',
    );
  });

  it('leaves a caregiver of the same household seated — only the co-parent seat is this door', async () => {
    const household = await seedSeatedHousehold();
    const [caregiver] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:caregiver-${households}` })
      .returning({ id: schema.users.id });
    const caregiverUserId = caregiver?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId: household.familyId,
      userId: caregiverUserId,
      role: 'grandparent',
    });

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: caregiverUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_departable', role: 'grandparent' });
    expect((await members(household.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'grandparent',
      'primary_parent',
    ]);
  });
});

/** The other household's co-parent is not this one's: the door is scoped by family,
 * and a departure asked with the wrong family id must find no seat rather than take
 * the one it can see. */
describe('departCoParent — scoped to the family that was asked', () => {
  it('finds no seat when the actor is a co-parent of a DIFFERENT household', async () => {
    const one = await seedSeatedHousehold();
    const two = await seedSeatedHousehold();

    const result = await departCoParent(db.database, {
      familyId: two.familyId,
      actorUserId: one.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_a_member' });
    expect((await members(one.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'primary_parent',
    ]);
  });

  /** A separated parent is one users row in two households, and the two doors record
   * DIFFERENT scopes — the SMS invite here, the forwardable link there. Leaving one
   * household may not end their consent in the other: a read that forgot to say which
   * family it meant would withdraw a scope this household never granted, and file the
   * row under this family while it was at it. */
  it('leaves the same person’s consent in another household standing', async () => {
    const one = await seedSeatedHousehold();
    const two = await seedSeatedHousehold();
    await db.database.insert(schema.consentRecords).values({
      userId: one.coParentUserId,
      familyId: two.familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_join_origination',
      policyVersion: POLICY_VERSION,
      grantedAt: NOW,
    });

    const result = await departCoParent(db.database, {
      familyId: one.familyId,
      actorUserId: one.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toMatchObject({ outcome: 'departed', consentWithdrawn: 1 });
    expect((await consentsOf(one.coParentUserId)).filter((c) => c.granted === false)).toEqual([
      {
        consentType: 'sms_service_messages',
        consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
        granted: false,
      },
    ]);
    const inOtherHousehold = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords)
      .where(
        and(
          eq(schema.consentRecords.userId, one.coParentUserId),
          eq(schema.consentRecords.familyId, two.familyId),
        ),
      );
    expect(inOtherHousehold).toEqual([{ granted: true }]);
  });
});

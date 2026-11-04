import { schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVITE_SILENCE_MS,
  acceptInvite,
  closeInviteOnGroupSeat,
  declineOpenInviteOnStop,
  loadOpenInviteByPhone,
  recordedSeatGrant,
} from '~/lib/channel/caregiver/invites';
import type { AddRole } from '~/lib/channel/caregiver/parse';
import { acceptCoParentInvite } from '~/lib/channel/coparent/accept';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { reenrolOnStart } from '~/lib/channel/intake/channel-state';
import {
  resolveSendablePhone,
  resolveVerifiedChannelByPhone,
  revokeSmsChannel,
} from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { recordSeatGrant } from '~/lib/testing/seat-grant';
import { type ListChatHandles, startGroupRoster } from './roster';
import { declineRosterMember, seatConfirmedMember, unseatCaregiverSeat } from './roster-seat';

/**
 * Group onboarding v2, PR B: a seat is written only on the person's own reply, and that
 * reply is the consent, stored verbatim with Hale's interpretation. Parents get the
 * co-parent seat; grandparents, nannies and babysitters get their scoped role. Nobody
 * gets `extended` or `service`.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const NANNY = '+14165550133';
const OTHER_PARENT = '+14165550141';
const GUEST = '+14165550151';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const CHAT = 'chat-family-group';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedHousehold(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
}

/** A roster the way PR A leaves it, with every unknown member already asked. */
async function askedRoster(handles: string[]) {
  const list: ListChatHandles = async () => ({ status: 'ok', handles, isGroup: true });
  const started = await startGroupRoster(db.database, {
    chatId: CHAT,
    source: 'added_to_existing',
    now: NOW,
    listHandles: list,
  });
  expect(started).toMatchObject({ outcome: 'roster_matched', status: 'roles_proposed' });
  await db.database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'asked', askedAt: NOW })
    .where(eq(schema.linqGroupRosterMembers.status, 'proposed'));
}

async function memberFor(phone: string) {
  const [row] = await db.database
    .select()
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.chatId, CHAT),
        eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(phone)),
      ),
    );
  if (!row) throw new Error('no roster member for that phone');
  return row;
}

async function rosterStatus() {
  const [row] = await db.database
    .select({
      status: schema.linqGroupRosters.status,
      confirmedAt: schema.linqGroupRosters.confirmedAt,
    })
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.chatId, CHAT));
  return row;
}

async function verbs(familyId: string) {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows;
}

describe('seatConfirmedMember', () => {
  it('seats a dad as co_parent on his own words, with that reply as the consent', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: DAD,
      role: 'co_parent',
      now: NOW,
    });
    await askedRoster([PARENT, DAD, GRAN]);
    const dad = await memberFor(DAD);

    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: dad.id,
      reading: { role: 'parent', parentRole: 'father' },
      verbatimReply: "I'm his dad",
      now: NOW,
    });
    expect(seated).toMatchObject({ outcome: 'seated', role: 'co_parent', groupRole: 'co_parent' });
    if (seated.outcome !== 'seated') throw new Error('not seated');

    const [membership] = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, seated.userId));
    expect(membership?.role).toBe('co_parent');

    const [seat] = await db.database
      .select({ role: schema.linqGroupMembers.role, chatId: schema.linqGroupMembers.chatId })
      .from(schema.linqGroupMembers)
      .where(eq(schema.linqGroupMembers.userId, seated.userId));
    expect(seat).toEqual({ role: 'co_parent', chatId: CHAT });

    const consents = await db.database
      .select({
        consentType: schema.consentRecords.consentType,
        consentScope: schema.consentRecords.consentScope,
        granted: schema.consentRecords.granted,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, seated.userId));
    expect(consents).toEqual([
      {
        consentType: 'sms_service_messages',
        consentScope: 'linq_group_role_reply',
        granted: true,
        evidence: {
          verbatimReply: "I'm his dad",
          interpretation: { role: 'co_parent', parentRole: 'father' },
          channel: 'imessage',
          chatId: CHAT,
        },
      },
    ]);

    const [channel] = await db.database
      .select({
        verifiedAt: schema.parentChannels.verifiedAt,
        familyId: schema.parentChannels.familyId,
      })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.userId, seated.userId));
    expect(channel).toEqual({ verifiedAt: NOW, familyId });

    const [user] = await db.database
      .select({
        externalAuthId: schema.users.externalAuthId,
        parentRole: schema.users.parentRole,
        parentRoleBasis: schema.users.parentRoleBasis,
      })
      .from(schema.users)
      .where(eq(schema.users.id, seated.userId));
    expect(user).toEqual({
      externalAuthId: `sms:${phoneBlindIndex(DAD)}`,
      parentRole: 'father',
      parentRoleBasis: 'stated',
    });

    const prefs = await db.database
      .select({ loopChannel: schema.loopPrefs.loopChannel })
      .from(schema.loopPrefs)
      .where(eq(schema.loopPrefs.userId, seated.userId));
    expect(prefs).toEqual([{ loopChannel: 'sms' }]);

    expect(await memberFor(DAD)).toMatchObject({
      status: 'confirmed',
      confirmedRole: 'co_parent',
      userId: seated.userId,
      confirmedAt: NOW,
    });
    expect((await rosterStatus())?.status).toBe('partial');
    const audited = (await verbs(familyId)).map((row) => row.actionTaken);
    expect(audited).toEqual(
      expect.arrayContaining(['linq_group_role_confirmed', 'linq_group_member_seated']),
    );
    expect(
      (await verbs(familyId)).find((row) => row.actionTaken === 'linq_group_role_confirmed')?.after,
    ).toEqual({ role: 'co_parent', via: 'own_reply' });
  });

  it('seats a grandparent in the scoped grandparent role, with caregiver consent and no parent rights', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    const gran = await memberFor(GRAN);

    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: gran.id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: 'grandma here!',
      now: NOW,
    });
    expect(seated).toMatchObject({
      outcome: 'seated',
      role: 'grandparent',
      groupRole: 'other_family',
    });
    if (seated.outcome !== 'seated') throw new Error('not seated');
    const [membership] = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, seated.userId));
    expect(membership?.role).toBe('grandparent');
    const consents = await db.database
      .select({
        consentType: schema.consentRecords.consentType,
        consentScope: schema.consentRecords.consentScope,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, seated.userId));
    expect(consents).toEqual([
      {
        consentType: 'caregiver_scoped_messages',
        consentScope: 'caregiver:grandparent',
        evidence: {
          verbatimReply: 'grandma here!',
          interpretation: { role: 'grandparent', parentRole: null },
          channel: 'imessage',
          chatId: CHAT,
        },
      },
    ]);
    expect(
      await db.database
        .select()
        .from(schema.loopPrefs)
        .where(eq(schema.loopPrefs.userId, seated.userId)),
    ).toEqual([]);
    expect((await rosterStatus())?.status).toBe('confirmed');
  });

  it('seats a nanny as a caregiver and confirms the roster once nobody is left to answer', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: NANNY,
      role: 'nanny',
      now: NOW,
    });
    await askedRoster([PARENT, NANNY]);

    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(NANNY)).id,
      reading: { role: 'nanny', parentRole: null },
      verbatimReply: 'Je suis la nounou',
      now: NOW,
    });
    expect(seated).toMatchObject({ outcome: 'seated', role: 'nanny', groupRole: 'caregiver' });
    const [consent] = await db.database
      .select({ consentScope: schema.consentRecords.consentScope })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.consentType, 'caregiver_scoped_messages'));
    expect(consent?.consentScope).toBe('caregiver:nanny');
    expect(await rosterStatus()).toEqual({ status: 'confirmed', confirmedAt: NOW });
  });

  it('refuses a phone already verified in another family, writes nothing here, and marks the member', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    await seedHousehold(OTHER_PARENT, 'Elsewhere');
    await askedRoster([PARENT, DAD]);
    // The other family's parent is in this chat too, but as an asked member of this roster.
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: (await memberFor(DAD)).rosterId,
      chatId: CHAT,
      phoneE164Encrypted: encryptString(OTHER_PARENT),
      phoneE164Hash: phoneBlindIndex(OTHER_PARENT),
      status: 'asked',
    });

    const refused = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(OTHER_PARENT)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: 'mom',
      now: NOW,
    });
    expect(refused).toEqual({ outcome: 'seat_refused', reason: 'other_family' });
    expect((await memberFor(OTHER_PARENT)).status).toBe('refused');
    expect(
      await db.database
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.familyId, familyId)),
    ).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    const familyRoles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(familyRoles).toEqual([{ role: 'primary_parent' }]);
  });

  it('refuses a caregiver of this family who says they are a parent, and keeps the role the family gave them', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const [nanny] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:nanny', name: 'Nanny' })
      .returning({ id: schema.users.id });
    const nannyUserId = nanny?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: nannyUserId, role: 'nanny' });
    await db.database.insert(schema.parentChannels).values({
      userId: nannyUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(NANNY),
      phoneE164Hash: phoneBlindIndex(NANNY),
      verifiedAt: NOW,
    });
    await askedRoster([PARENT, NANNY]);

    const refused = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(NANNY)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: 'mom here',
      now: NOW,
    });
    expect(refused).toEqual({ outcome: 'seat_refused', reason: 'role_conflict' });
    expect((await memberFor(NANNY)).status).toBe('refused');
    const [membership] = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, nannyUserId));
    expect(membership?.role).toBe('nanny');
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  });

  it('seats nobody who was not asked', async () => {
    await seedHousehold(PARENT, 'Parent');
    await askedRoster([PARENT, DAD]);
    await db.database
      .update(schema.linqGroupRosterMembers)
      .set({ status: 'proposed' })
      .where(eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(DAD)));

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(DAD)).id,
      reading: { role: 'parent', parentRole: 'father' },
      verbatimReply: 'dad',
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'member_not_asked' });
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
  });
});

async function refusedAudits(familyId: string) {
  return (await verbs(familyId))
    .filter((row) => row.actionTaken === 'linq_group_member_refused')
    .map((row) => row.after);
}

/**
 * VIL-582: a who's-who reply is the claimant's own yes and nothing more. A seat needs the
 * household parent's recorded grant for that phone and that role; without it the reply
 * only labels the person, on the audit row, and writes no seat.
 */
describe('seatConfirmedMember without a parent grant', () => {
  it('labels a stranger who claims the empty co-parent seat and writes no seat rows', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    await askedRoster([PARENT, GUEST]);

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GUEST)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: "I'm Mila's mom",
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(
      await db.database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId)),
    ).toEqual([{ role: 'primary_parent' }]);
    expect(
      await db.database
        .select({ id: schema.parentChannels.id })
        .from(schema.parentChannels)
        .where(eq(schema.parentChannels.familyId, familyId)),
    ).toHaveLength(1);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(await db.database.select().from(schema.loopPrefs)).toEqual([]);
    expect(
      await db.database
        .select()
        .from(schema.users)
        .where(eq(schema.users.externalAuthId, `sms:${phoneBlindIndex(GUEST)}`)),
    ).toEqual([]);
    expect(await memberFor(GUEST)).toMatchObject({ status: 'refused', userId: null });
    expect(await refusedAudits(familyId)).toEqual([
      { reason: 'seat_needs_parent_grant', claimedRole: 'co_parent', via: 'own_reply' },
    ]);
  });

  it('labels a grandparent claim with no grant and writes no caregiver seat', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    await askedRoster([PARENT, GRAN]);

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(
      await db.database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId)),
    ).toEqual([{ role: 'primary_parent' }]);
    expect(
      await db.database
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.consentType, 'caregiver_scoped_messages')),
    ).toEqual([]);
    expect(await db.database.select().from(schema.parentChannels)).toHaveLength(1);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(await refusedAudits(familyId)).toEqual([
      { reason: 'seat_needs_parent_grant', claimedRole: 'grandparent', via: 'own_reply' },
    ]);
  });

  it('seats the same co-parent claim once the parent recorded a grant, and closes that invite', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GUEST,
      role: 'co_parent',
      now: NOW,
    });
    await askedRoster([PARENT, GUEST]);

    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GUEST)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: "I'm Mila's mom",
      now: NOW,
    });

    expect(seated).toMatchObject({ outcome: 'seated', role: 'co_parent', groupRole: 'co_parent' });
    if (seated.outcome !== 'seated') throw new Error('not seated');
    const [membership] = await db.database
      .select({
        role: schema.familyMembers.role,
        invitedByUserId: schema.familyMembers.invitedByUserId,
      })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, seated.userId));
    expect(membership).toEqual({ role: 'co_parent', invitedByUserId: parentUserId });
    const channels = await db.database
      .select({ verifiedAt: schema.parentChannels.verifiedAt })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(GUEST)));
    expect(channels).toEqual([{ verifiedAt: NOW }]);
    const [consent] = await db.database
      .select({
        consentScope: schema.consentRecords.consentScope,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, seated.userId));
    expect(consent?.consentScope).toBe('linq_group_role_reply');
    expect((consent?.evidence as { verbatimReply?: string }).verbatimReply).toBe("I'm Mila's mom");

    const [invite] = await db.database
      .select({
        state: schema.caregiverInvites.state,
        caregiverUserId: schema.caregiverInvites.caregiverUserId,
        closedAt: schema.caregiverInvites.closedAt,
      })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite).toEqual({ state: 'accepted', caregiverUserId: seated.userId, closedAt: NOW });
    const accepted = await db.database
      .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'co_parent_invite_accepted'));
    expect(accepted).toEqual([
      { targetId: inviteId, after: { role: 'co_parent', via: 'linq_group' } },
    ]);
    expect(await loadOpenInviteByPhone(db.database, GUEST, NOW)).toBeNull();
  });

  it('seats a grandparent with a caregiver grant and closes that invite as a caregiver invite', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);

    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });

    expect(seated).toMatchObject({ outcome: 'seated', role: 'grandparent' });
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite).toEqual({ state: 'accepted', closedAt: NOW });
    const accepted = await db.database
      .select({ targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'caregiver_invite_accepted'));
    expect(accepted).toEqual([{ targetId: inviteId }]);
  });

  it('binds the grant to the phone it was recorded for', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: NANNY,
      role: 'nanny',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN, NANNY]);

    const impostor = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'nanny', parentRole: null },
      verbatimReply: "I'm the nanny",
      now: NOW,
    });
    expect(impostor).toEqual({ outcome: 'seat_needs_parent_grant' });

    const nanny = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(NANNY)).id,
      reading: { role: 'nanny', parentRole: null },
      verbatimReply: "I'm the nanny",
      now: NOW,
    });
    expect(nanny).toMatchObject({ outcome: 'seated', role: 'nanny' });
  });

  it('binds the grant to the role it was recorded for', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: DAD,
      role: 'co_parent',
      now: NOW,
    });
    await askedRoster([PARENT, DAD]);

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(DAD)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandpa",
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  });

  /**
   * The legacy `identity_noted` seat leaves exactly this: an `accepted` invite whose member
   * still holds the co-parent role, a verified channel, and no grant. Asked first, so the
   * channel written after does not make the member `known`.
   */
  async function acceptedWithoutGrant() {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await askedRoster([PARENT, DAD]);
    const [dad] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${phoneBlindIndex(DAD)}`, name: 'Dad' })
      .returning({ id: schema.users.id });
    const dadUserId = dad?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: dadUserId, role: 'co_parent' });
    await db.database.insert(schema.parentChannels).values({
      userId: dadUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(DAD),
      phoneE164Hash: phoneBlindIndex(DAD),
      verifiedAt: NOW,
    });
    const [invite] = await db.database
      .insert(schema.caregiverInvites)
      .values({
        familyId,
        invitedByUserId: parentUserId,
        role: 'co_parent',
        displayName: 'Noted number',
        phoneE164Encrypted: encryptString(DAD),
        phoneE164Hash: phoneBlindIndex(DAD),
        state: 'accepted',
        caregiverUserId: dadUserId,
        expiresAt: NOW,
        closedAt: NOW,
      })
      .returning({ id: schema.caregiverInvites.id });
    return { familyId, parentUserId, dadUserId, inviteId: invite?.id as string };
  }

  async function claimDad() {
    return seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(DAD)).id,
      reading: { role: 'parent', parentRole: 'father' },
      verbatimReply: "I'm his dad",
      now: NOW,
    });
  }

  it('does not read an accepted invite whose member holds the role, with no grant audit row, as a grant', async () => {
    const { familyId } = await acceptedWithoutGrant();

    expect(
      await recordedSeatGrant(db.database, {
        familyId,
        phoneE164Hash: phoneBlindIndex(DAD),
        role: 'co_parent',
        now: NOW,
      }),
    ).toBeNull();
    expect(await claimDad()).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(await refusedAudits(familyId)).toEqual([
      { reason: 'seat_needs_parent_grant', claimedRole: 'co_parent', via: 'own_reply' },
    ]);
  });

  it('reads the same accepted invite as a grant once its own grant audit row is bound to it', async () => {
    const { familyId, parentUserId, dadUserId, inviteId } = await acceptedWithoutGrant();
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: parentUserId,
      actionTaken: 'co_parent_access_granted',
      targetTable: 'caregiver_invites',
      targetId: inviteId,
      after: { role: 'co_parent' },
    });

    expect(
      await recordedSeatGrant(db.database, {
        familyId,
        phoneE164Hash: phoneBlindIndex(DAD),
        role: 'co_parent',
        now: NOW,
      }),
    ).toEqual({ inviteId, grantedByUserId: parentUserId, open: false });
    expect(await claimDad()).toMatchObject({ outcome: 'seated', userId: dadUserId });
  });
});

/** The same database, with `before` run just as the seat opens its transaction. */
function interleaved(before: () => Promise<void>): TestDb['database'] {
  const target = db.database;
  return new Proxy(target, {
    get(object, property) {
      if (property === 'transaction') {
        return async (...args: Parameters<typeof target.transaction>) => {
          await before();
          return object.transaction(...args);
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** A grandparent who accepted 1:1 and still holds the role: an accepted (not open) grant. */
async function acceptedGran() {
  const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
  await recordSeatGrant(db.database, {
    familyId,
    parentUserId,
    phoneE164: GRAN,
    role: 'grandparent',
    now: NOW,
  });
  const invite = await loadOpenInviteByPhone(db.database, GRAN, NOW);
  if (!invite || invite.role === 'co_parent') throw new Error('no open caregiver invite');
  await acceptInvite(db.database, { invite, verbatimReply: 'yes', now: NOW });
  await askedRoster([PARENT, GRAN]);
  const [gran] = await db.database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'grandparent'),
      ),
    );
  if (!gran) throw new Error('accept left no grandparent member');
  return { familyId, parentUserId, granUserId: gran.userId };
}

async function claimGran(database: TestDb['database']) {
  return seatConfirmedMember(database, {
    rosterMemberId: (await memberFor(GRAN)).id,
    reading: { role: 'grandparent', parentRole: null },
    verbatimReply: "I'm grandma",
    now: NOW,
  });
}

/**
 * VIL-582 security P2: the grant is read before the seat's transaction, so the seat
 * re-reads it inside, with the invite row locked. A grant that ended in between rolls
 * the seat back and names it.
 */
describe('seatConfirmedMember when the grant ends between the read and the seat', () => {
  async function grantedGuest() {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GUEST,
      role: 'co_parent',
      now: NOW,
    });
    await askedRoster([PARENT, GUEST]);
    return { familyId, parentUserId, inviteId };
  }

  it('rolls the seat back and names grant_changed_during_seat when the invite closes in between', async () => {
    const { familyId, inviteId } = await grantedGuest();
    const closing = interleaved(async () => {
      await db.database
        .update(schema.caregiverInvites)
        .set({ state: 'declined', closedAt: NOW })
        .where(eq(schema.caregiverInvites.id, inviteId));
    });

    const result = await seatConfirmedMember(closing, {
      rosterMemberId: (await memberFor(GUEST)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: "I'm Mila's mom",
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'grant_changed_during_seat' });
    expect(
      await db.database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId)),
    ).toEqual([{ role: 'primary_parent' }]);
    expect(
      await db.database
        .select()
        .from(schema.parentChannels)
        .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(GUEST))),
    ).toEqual([]);
    expect(
      await db.database
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.consentScope, 'linq_group_role_reply')),
    ).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(
      await db.database
        .select()
        .from(schema.users)
        .where(eq(schema.users.externalAuthId, `sms:${phoneBlindIndex(GUEST)}`)),
    ).toEqual([]);
    expect((await memberFor(GUEST)).status).toBe('asked');
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite?.state).toBe('declined');
  });

  it("rolls the seat back when the open grant's inviter stops being a parent in between", async () => {
    const { familyId, parentUserId, inviteId } = await grantedGuest();
    const leaving = interleaved(async () => {
      await db.database
        .delete(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, parentUserId));
    });

    const result = await seatConfirmedMember(leaving, {
      rosterMemberId: (await memberFor(GUEST)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: "I'm Mila's mom",
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'grant_changed_during_seat' });
    expect(
      await db.database
        .select()
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId)),
    ).toEqual([]);
    expect(
      await db.database
        .select()
        .from(schema.parentChannels)
        .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(GUEST))),
    ).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite?.state).toBe('awaiting_caregiver_reply');
  });

  it("rolls the seat back when the accepted grant's member leaves in between, and does not re-add them", async () => {
    const { granUserId } = await acceptedGran();
    const departing = interleaved(async () => {
      await db.database
        .delete(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, granUserId));
    });

    expect(await claimGran(departing)).toEqual({ outcome: 'grant_changed_during_seat' });
    expect(
      await db.database
        .select()
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, granUserId)),
    ).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  });

  it('seats the same accepted grant through the interleaving when its member stays', async () => {
    const { granUserId } = await acceptedGran();

    expect(await claimGran(interleaved(async () => {}))).toMatchObject({
      outcome: 'seated',
      role: 'grandparent',
      userId: granUserId,
    });
  });

  it('seats through the same interleaving when nothing changes the grant', async () => {
    await grantedGuest();
    const untouched = interleaved(async () => {});

    const result = await seatConfirmedMember(untouched, {
      rosterMemberId: (await memberFor(GUEST)).id,
      reading: { role: 'parent', parentRole: 'mother' },
      verbatimReply: "I'm Mila's mom",
      now: NOW,
    });

    expect(result).toMatchObject({ outcome: 'seated', role: 'co_parent' });
  });
});

async function channelsFor(phone: string) {
  return db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(phone)));
}

async function grantedCaregiverConsents(userId: string) {
  return db.database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentType, 'caregiver_scoped_messages'),
        eq(schema.consentRecords.granted, true),
      ),
    );
}

async function inviteState(familyId: string, phone: string) {
  const [invite] = await db.database
    .select({ state: schema.caregiverInvites.state })
    .from(schema.caregiverInvites)
    .where(
      and(
        eq(schema.caregiverInvites.familyId, familyId),
        eq(schema.caregiverInvites.phoneE164Hash, phoneBlindIndex(phone)),
      ),
    );
  return invite?.state;
}

/**
 * VIL-596: a STOP is the person's no, and it outranks every household grant. A number
 * whose channel was revoked and never re-opened is refused `opted_out` by the seat, with
 * nothing written into the family, until the person opts back in themselves. And the seat
 * holds the rows its grant rests on, so a removal or a STOP cannot commit underneath it.
 */
describe('seatConfirmedMember for a number that texted STOP', () => {
  /** The two writers the 1:1 STOP runs for an accepted caregiver. */
  async function granTextsStop(familyId: string, granUserId: string) {
    expect(await declineOpenInviteOnStop(db.database, GRAN, NOW)).toBe(false);
    expect(
      await revokeSmsChannel(db.database, { userId: granUserId, familyId }, { now: NOW }),
    ).toEqual({ status: 'revoked' });
  }

  it('refuses an accepted caregiver who texted STOP 1:1, and re-opens no channel for them', async () => {
    const { familyId, parentUserId, granUserId } = await acceptedGran();
    expect(await resolveVerifiedChannelByPhone(db.database, GRAN)).toMatchObject({
      userId: granUserId,
      familyId,
    });
    const grant = {
      familyId,
      phoneE164Hash: phoneBlindIndex(GRAN),
      role: 'grandparent' as const,
      now: NOW,
    };
    expect(await recordedSeatGrant(db.database, grant)).toMatchObject({
      grantedByUserId: parentUserId,
      open: false,
    });

    await granTextsStop(familyId, granUserId);
    expect(await recordedSeatGrant(db.database, grant)).toMatchObject({
      grantedByUserId: parentUserId,
      open: false,
    });
    expect(await resolveVerifiedChannelByPhone(db.database, GRAN)).toBeNull();

    expect(await claimGran(db.database)).toEqual({ outcome: 'seat_refused', reason: 'opted_out' });
    const channels = await channelsFor(GRAN);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.revokedAt).not.toBeNull();
    expect(await resolveVerifiedChannelByPhone(db.database, GRAN)).toBeNull();
    expect(await resolveSendablePhone(db.database, granUserId)).toBeNull();
    expect(await grantedCaregiverConsents(granUserId)).toHaveLength(1);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect((await memberFor(GRAN)).status).toBe('refused');
    const audits = await verbs(familyId);
    expect(audits).toContainEqual({
      actionTaken: 'linq_group_member_refused',
      after: { reason: 'opted_out', via: 'own_reply' },
    });
    expect(audits.map((row) => row.actionTaken)).not.toContain('linq_group_member_seated');
    expect(await inviteState(familyId, GRAN)).toBe('accepted');
  });

  it.each([
    ['this family', false],
    ['another family', true],
  ])(
    'refuses a number whose channel was revoked in %s, though a parent granted it again',
    async (_, elsewhere) => {
      const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
      const stoppedIn = elsewhere
        ? (await seedHousehold(OTHER_PARENT, 'Other parent')).familyId
        : familyId;
      const [guest] = await db.database
        .insert(schema.users)
        .values({ externalAuthId: `sms:${phoneBlindIndex(GUEST)}`, name: null })
        .returning({ id: schema.users.id });
      await db.database.insert(schema.parentChannels).values({
        userId: guest?.id as string,
        familyId: stoppedIn,
        kind: 'sms',
        phoneE164Encrypted: encryptString(GUEST),
        phoneE164Hash: phoneBlindIndex(GUEST),
        verifiedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        revokedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        consentRecordId: null,
      });
      await recordSeatGrant(db.database, {
        familyId,
        parentUserId,
        phoneE164: GUEST,
        role: 'co_parent',
        now: NOW,
      });
      await askedRoster([PARENT, GUEST]);
      expect(
        await recordedSeatGrant(db.database, {
          familyId,
          phoneE164Hash: phoneBlindIndex(GUEST),
          role: 'co_parent',
          now: NOW,
        }),
      ).toMatchObject({ open: true });

      const result = await seatConfirmedMember(db.database, {
        rosterMemberId: (await memberFor(GUEST)).id,
        reading: { role: 'parent', parentRole: 'mother' },
        verbatimReply: "I'm Mila's mom",
        now: NOW,
      });

      expect(result).toEqual({ outcome: 'seat_refused', reason: 'opted_out' });
      const channels = await channelsFor(GUEST);
      expect(channels).toHaveLength(1);
      expect(channels[0]?.revokedAt).not.toBeNull();
      expect(
        await db.database
          .select({ role: schema.familyMembers.role })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, familyId)),
      ).toEqual([{ role: 'primary_parent' }]);
      expect(
        await db.database
          .select()
          .from(schema.consentRecords)
          .where(eq(schema.consentRecords.consentScope, 'linq_group_role_reply')),
      ).toEqual([]);
      expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
      expect(await inviteState(familyId, GUEST)).toBe('awaiting_caregiver_reply');
      expect(await verbs(familyId)).toContainEqual({
        actionTaken: 'linq_group_member_refused',
        after: { reason: 'opted_out', via: 'own_reply' },
      });
    },
  );

  it('seats the same caregiver once they texted START themselves, on the channel START opened', async () => {
    const { familyId, granUserId } = await acceptedGran();
    await granTextsStop(familyId, granUserId);
    await reenrolOnStart(
      db.database,
      { userId: granUserId, familyId, phoneE164: GRAN, verbatimReply: 'START' },
      NOW,
    );

    expect(await claimGran(db.database)).toMatchObject({
      outcome: 'seated',
      role: 'grandparent',
      userId: granUserId,
    });
    expect(await channelsFor(GRAN)).toHaveLength(2);
  });

  it('honours a STOP that lands after the pre-check, and writes no consent after it', async () => {
    const { familyId, granUserId } = await acceptedGran();
    const stopping = interleaved(async () => {
      expect(
        await revokeSmsChannel(db.database, { userId: granUserId, familyId }, { now: NOW }),
      ).toEqual({ status: 'revoked' });
    });

    expect(await claimGran(stopping)).toEqual({ outcome: 'seat_refused', reason: 'opted_out' });
    const channels = await channelsFor(GRAN);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.revokedAt).not.toBeNull();
    expect(await grantedCaregiverConsents(granUserId)).toHaveLength(1);
    const [newest] = await db.database
      .select({
        consentType: schema.consentRecords.consentType,
        granted: schema.consentRecords.granted,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, granUserId))
      .orderBy(desc(schema.consentRecords.grantedAt))
      .limit(1);
    expect(newest).toEqual({ consentType: 'sms_service_messages', granted: false });
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect((await memberFor(GRAN)).status).toBe('refused');
    const audits = await verbs(familyId);
    expect(audits).toContainEqual({
      actionTaken: 'linq_group_member_refused',
      after: { reason: 'opted_out', via: 'own_reply' },
    });
    expect(audits.map((row) => row.actionTaken)).not.toContain('linq_group_member_seated');
  });
});

/**
 * VIL-582: a grant opens a seat only while it still stands. Each case first proves the
 * grant counted (the positive control), then ends it the way the household would, and the
 * same claim gets the label and no seat.
 */
describe('seatConfirmedMember with a grant that no longer stands', () => {
  const LATER = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);

  async function grantFor(familyId: string, phone: string, role: AddRole, now = NOW) {
    return recordedSeatGrant(db.database, {
      familyId,
      phoneE164Hash: phoneBlindIndex(phone),
      role,
      now,
    });
  }

  async function activeChannels(phone: string) {
    return db.database
      .select({ id: schema.parentChannels.id })
      .from(schema.parentChannels)
      .where(
        and(
          eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(phone)),
          isNull(schema.parentChannels.revokedAt),
        ),
      );
  }

  it('does not reseat a co-parent who left the household', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: DAD,
      role: 'co_parent',
      now: NOW,
    });
    const invite = await loadOpenInviteByPhone(db.database, DAD, NOW);
    if (invite?.role !== 'co_parent') throw new Error('no open co-parent invite');
    const accepted = await acceptCoParentInvite(db.database, {
      invite,
      verbatimReply: 'yes',
      now: NOW,
    });
    if (accepted.outcome !== 'seated') throw new Error(`accept: ${accepted.outcome}`);
    expect(await grantFor(familyId, DAD, 'co_parent', LATER)).not.toBeNull();

    await departCoParent(db.database, {
      familyId,
      actorUserId: accepted.coParentUserId,
      now: NOW,
    });
    expect(await activeChannels(DAD)).toEqual([]);
    expect(await grantFor(familyId, DAD, 'co_parent', LATER)).toBeNull();
    await askedRoster([PARENT, DAD]);

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(DAD)).id,
      reading: { role: 'parent', parentRole: 'father' },
      verbatimReply: "I'm the dad",
      now: LATER,
    });

    // Departure revoked his channel and nothing re-opened it, so the seat reads him as
    // opted out before it reads any grant (VIL-596).
    expect(result).toEqual({ outcome: 'seat_refused', reason: 'opted_out' });
    expect(await activeChannels(DAD)).toEqual([]);
    expect(
      await db.database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId)),
    ).toEqual([{ role: 'primary_parent' }]);
  });

  it('does not reseat a grandparent a parent took out of the group', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });
    if (seated.outcome !== 'seated') throw new Error('not seated');
    expect(await grantFor(familyId, GRAN, 'grandparent', LATER)).not.toBeNull();
    await unseatCaregiverSeat(db.database, {
      familyId,
      userId: seated.userId,
      chatId: CHAT,
      via: 'participant_removed',
      now: NOW,
    });

    // Added back to the group and asked again: the who's-who leaves the member 'asked'.
    await db.database
      .update(schema.linqGroupRosterMembers)
      .set({ status: 'asked', askedAt: LATER })
      .where(eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(GRAN)));
    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: LATER,
    });

    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(
      await db.database
        .select()
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, seated.userId)),
    ).toEqual([]);
    expect(
      await db.database
        .select()
        .from(schema.linqGroupMembers)
        .where(isNull(schema.linqGroupMembers.removedAt)),
    ).toEqual([]);
  });

  it('seats a grandparent who accepted 1:1 and still holds the role, without a second acceptance', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    const invite = await loadOpenInviteByPhone(db.database, GRAN, NOW);
    if (!invite || invite.role === 'co_parent') throw new Error('no open caregiver invite');
    await acceptInvite(db.database, { invite, verbatimReply: 'yes', now: NOW });
    await askedRoster([PARENT, GRAN]);

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: LATER,
    });

    expect(result).toMatchObject({ outcome: 'seated', role: 'grandparent' });
    const acceptances = await db.database
      .select({ targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'caregiver_invite_accepted'));
    expect(acceptances).toEqual([{ targetId: inviteId }]);
  });

  it('does not count a grant once its inviter is no longer a parent here', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    expect(await grantFor(familyId, GRAN, 'grandparent')).not.toBeNull();
    await db.database
      .update(schema.familyMembers)
      .set({ role: 'nanny' })
      .where(eq(schema.familyMembers.userId, parentUserId));

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
  });

  it('does not count an invite the invitee let lapse', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    const lapsed = new Date(NOW.getTime() + INVITE_SILENCE_MS + 1);
    expect(await grantFor(familyId, GRAN, 'grandparent', NOW)).not.toBeNull();

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: lapsed,
    });
    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
  });

  it('does not count an awaiting invite that was closed', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    expect(await grantFor(familyId, GRAN, 'grandparent')).not.toBeNull();
    await db.database
      .update(schema.caregiverInvites)
      .set({ closedAt: NOW })
      .where(eq(schema.caregiverInvites.id, inviteId));

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
  });

  it.each([
    'declined',
    'expired',
    'superseded',
    'superseded_by_join',
    'superseded_by_enrollment',
    'seat_taken',
  ] as const)(
    'does not count a granted invite that ended %s, even for its own member',
    async (state) => {
      const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
      const inviteId = await recordSeatGrant(db.database, {
        familyId,
        parentUserId,
        phoneE164: GRAN,
        role: 'grandparent',
        now: NOW,
      });
      const invite = await loadOpenInviteByPhone(db.database, GRAN, NOW);
      if (!invite || invite.role === 'co_parent') throw new Error('no open caregiver invite');
      await acceptInvite(db.database, { invite, verbatimReply: 'yes', now: NOW });
      await askedRoster([PARENT, GRAN]);
      expect(await grantFor(familyId, GRAN, 'grandparent')).not.toBeNull();
      await db.database
        .update(schema.caregiverInvites)
        .set({ state, closedAt: NOW })
        .where(eq(schema.caregiverInvites.id, inviteId));

      const result = await seatConfirmedMember(db.database, {
        rosterMemberId: (await memberFor(GRAN)).id,
        reading: { role: 'grandparent', parentRole: null },
        verbatimReply: "I'm grandma",
        now: NOW,
      });
      expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
    },
  );

  it('does not let one caregiver role grant open another', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'nanny',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    expect(await grantFor(familyId, GRAN, 'nanny')).not.toBeNull();

    const result = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: "I'm grandma",
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'seat_needs_parent_grant' });
  });
});

describe('closeInviteOnGroupSeat', () => {
  it('leaves an invite that was already accepted as it was, with no second acceptance', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    const invite = await loadOpenInviteByPhone(db.database, GRAN, NOW);
    if (!invite || invite.role === 'co_parent') throw new Error('no open caregiver invite');
    const { caregiverUserId } = await acceptInvite(db.database, {
      invite,
      verbatimReply: 'yes',
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 60_000);

    expect(
      await closeInviteOnGroupSeat(db.database, {
        inviteId,
        role: 'grandparent',
        familyId,
        seatedUserId: parentUserId,
        now: later,
      }),
    ).toBe(false);

    const [row] = await db.database
      .select({
        state: schema.caregiverInvites.state,
        caregiverUserId: schema.caregiverInvites.caregiverUserId,
        closedAt: schema.caregiverInvites.closedAt,
      })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(row).toEqual({ state: 'accepted', caregiverUserId, closedAt: NOW });
    const acceptances = await db.database
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'caregiver_invite_accepted'));
    expect(acceptances).toEqual([{ actor: caregiverUserId }]);
  });

  it('says it closed an invite that was still awaiting the invitee', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    const inviteId = await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });

    expect(
      await closeInviteOnGroupSeat(db.database, {
        inviteId,
        role: 'grandparent',
        familyId,
        seatedUserId: parentUserId,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('declineRosterMember', () => {
  it('writes no seat, user or consent for "not family", and audits the decline', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    await askedRoster([PARENT, GRAN, NANNY]);
    const usersBefore = (await db.database.select().from(schema.users)).length;

    const notFamily = await declineRosterMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      status: 'not_family',
      now: NOW,
    });
    expect(notFamily).toEqual({ outcome: 'declined', status: 'not_family' });
    const declined = await declineRosterMember(db.database, {
      rosterMemberId: (await memberFor(NANNY)).id,
      status: 'declined',
      now: NOW,
    });
    expect(declined).toEqual({ outcome: 'declined', status: 'declined' });

    expect((await db.database.select().from(schema.users)).length).toBe(usersBefore);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect((await memberFor(GRAN)).status).toBe('not_family');
    expect((await memberFor(NANNY)).status).toBe('declined');
    expect((await rosterStatus())?.status).toBe('confirmed');
    const declines = (await verbs(familyId)).filter(
      (row) => row.actionTaken === 'linq_group_role_declined',
    );
    expect(declines.map((row) => row.after)).toEqual([
      { status: 'not_family' },
      { status: 'declined' },
    ]);
  });
});

describe('unseatCaregiverSeat', () => {
  it('takes back a group-granted grandparent seat and withdraws its consent', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: GRAN,
      role: 'grandparent',
      now: NOW,
    });
    await askedRoster([PARENT, GRAN]);
    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(GRAN)).id,
      reading: { role: 'grandparent', parentRole: null },
      verbatimReply: 'grandma',
      now: NOW,
    });
    if (seated.outcome !== 'seated') throw new Error('not seated');
    const later = new Date(NOW.getTime() + 60_000);

    const unseated = await unseatCaregiverSeat(db.database, {
      familyId,
      userId: seated.userId,
      chatId: CHAT,
      via: 'participant_removed',
      now: later,
    });
    expect(unseated).toEqual({ outcome: 'unseated', role: 'grandparent' });
    expect(
      await db.database
        .select()
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, seated.userId)),
    ).toEqual([]);
    const [seat] = await db.database
      .select({ removedAt: schema.linqGroupMembers.removedAt })
      .from(schema.linqGroupMembers);
    expect(seat?.removedAt).toEqual(later);
    const consents = await db.database
      .select({
        consentScope: schema.consentRecords.consentScope,
        granted: schema.consentRecords.granted,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, seated.userId));
    expect(consents).toEqual(
      expect.arrayContaining([
        { consentScope: 'caregiver:grandparent', granted: true },
        { consentScope: 'caregiver:grandparent', granted: false },
      ]),
    );
    expect((await memberFor(GRAN)).status).toBe('removed');
    const unseatAudit = (await verbs(familyId)).find(
      (row) => row.actionTaken === 'linq_group_member_unseated',
    );
    expect(unseatAudit?.after).toEqual({ role: 'grandparent', via: 'participant_removed' });

    expect(
      await unseatCaregiverSeat(db.database, {
        familyId,
        userId: seated.userId,
        chatId: CHAT,
        via: 'participant_removed',
        now: later,
      }),
    ).toEqual({ outcome: 'not_seated' });
  });

  it('leaves a co-parent to the departure flow', async () => {
    const { familyId, userId: parentUserId } = await seedHousehold(PARENT, 'Parent');
    await recordSeatGrant(db.database, {
      familyId,
      parentUserId,
      phoneE164: DAD,
      role: 'co_parent',
      now: NOW,
    });
    await askedRoster([PARENT, DAD]);
    const seated = await seatConfirmedMember(db.database, {
      rosterMemberId: (await memberFor(DAD)).id,
      reading: { role: 'parent', parentRole: 'father' },
      verbatimReply: 'dad',
      now: NOW,
    });
    if (seated.outcome !== 'seated') throw new Error('not seated');
    expect(
      await unseatCaregiverSeat(db.database, {
        familyId,
        userId: seated.userId,
        chatId: CHAT,
        via: 'participant_removed',
        now: NOW,
      }),
    ).toEqual({ outcome: 'not_caregiver' });
    const [membership] = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, seated.userId));
    expect(membership?.role).toBe('co_parent');
  });
});

import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
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
    const { familyId } = await seedHousehold(PARENT, 'Parent');
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
    await seedHousehold(PARENT, 'Parent');
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
    await seedHousehold(PARENT, 'Parent');
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
      .from(schema.consentRecords);
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
    const { familyId } = await seedHousehold(PARENT, 'Parent');
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
    const { familyId } = await seedHousehold(PARENT, 'Parent');
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

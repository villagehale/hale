import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  declinePrivilegedGroupSeat,
  dutyAssigneeIds,
  groupMemberWelcome,
  groupStrangerHold,
  holdTrueStrangerOnce,
  seatParticipantAdded,
  unseatParticipantRemoved,
} from './group-members';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT = '+14165550111';
const FROM = '+16462352164';
const NOW = new Date('2026-09-30T18:00:00.000Z');
const CHAT = 'chat-household-group';

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
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: name,
      provinceOrState: 'ON',
      linqGroupChatId: phone === PARENT ? CHAT : null,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
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

async function liveRoles(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({
      familyId: schema.linqGroupMembers.familyId,
      role: schema.linqGroupMembers.role,
      removedAt: schema.linqGroupMembers.removedAt,
    })
    .from(schema.linqGroupMembers);
  return rows
    .filter((row) => row.familyId === familyId && row.removedAt == null)
    .map((row) => row.role);
}

/** A person this family already holds: a verified channel and a family role here. */
async function seedMember(
  familyId: string,
  phone: string,
  role: 'co_parent' | 'grandparent' | 'extended' | null,
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}` })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  if (role) await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return userId;
}

async function rowsFor(familyId: string, phone: string) {
  const hash = phoneBlindIndex(phone);
  return {
    users: await db.database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalAuthId, `sms:${hash}`)),
    familyMembers: await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId)),
    consents: await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.consentScope, 'linq_group_member')),
    channels: await db.database
      .select({ id: schema.parentChannels.id })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.phoneE164Hash, hash)),
    seats: await db.database
      .select({ id: schema.linqGroupMembers.id })
      .from(schema.linqGroupMembers)
      .where(eq(schema.linqGroupMembers.phoneE164Hash, hash)),
  };
}

const NOTHING_WRITTEN = { users: [], consents: [], channels: [], seats: [] };

describe('linq group members', () => {
  it('seats a parent add of a person the family holds with one welcome, with no cap', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    const wire = sender();
    await seedMember(seeded.familyId, '+14165550122', 'grandparent');
    const first = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(first).toMatchObject({
      outcome: 'group_member_seated',
      role: 'other_family',
      notice: 'sent',
    });
    expect(wire.texts).toEqual([await groupMemberWelcome('en', 'Barton')]);

    const again = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(again.outcome).toBe('group_member_already');
    expect(wire.texts).toHaveLength(1);

    await seedMember(seeded.familyId, '+14165550133', 'co_parent');
    const coParent = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550133',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(coParent).toMatchObject({
      outcome: 'group_member_seated',
      role: 'co_parent',
      notice: 'skipped',
    });

    for (const phone of ['+14165550144', '+14165550155']) {
      await seedMember(seeded.familyId, phone, 'extended');
      const seated = await seatParticipantAdded(db.database, {
        chatId: CHAT,
        participantHandle: phone,
        actorHandle: PARENT,
        isFromMe: false,
        now: NOW,
        send: wire.send,
      });
      expect(seated).toMatchObject({
        outcome: 'group_member_seated',
        role: 'other_family',
        notice: 'sent',
      });
    }
    const roles = await liveRoles(seeded.familyId);
    expect(roles.filter((role) => role === 'co_parent')).toHaveLength(1);
    expect(roles.filter((role) => role === 'other_family')).toHaveLength(3);
    const outbound = await db.database
      .select({
        parentUserId: schema.channelMessages.parentUserId,
        dedupeKey: schema.channelMessages.dedupeKey,
        providerChatId: schema.channelMessages.providerChatId,
      })
      .from(schema.channelMessages);
    expect(outbound.every((row) => row.parentUserId === seeded.userId)).toBe(true);
    expect(outbound.every((row) => row.providerChatId === CHAT)).toBe(true);
    expect(new Set(outbound.map((row) => row.dedupeKey)).size).toBe(outbound.length);
  });

  it('seats nobody when Linq names no actor or Hale is the actor', async () => {
    const { familyId } = await seedFamily(PARENT, 'Barton');
    const wire = sender();
    const unnamed = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550166',
      actorHandle: null,
      isFromMe: true,
      now: NOW,
      send: wire.send,
    });
    expect(unnamed).toEqual({ outcome: 'group_member_refused', reason: 'actor' });
    expect(await rowsFor(familyId, '+14165550166')).toEqual({
      ...NOTHING_WRITTEN,
      familyMembers: [{ role: 'primary_parent' }],
    });

    const hale = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550177',
      actorHandle: FROM,
      isFromMe: true,
      now: NOW,
      send: wire.send,
    });
    expect(hale).toEqual({ outcome: 'group_member_refused', reason: 'actor' });
    expect(await rowsFor(familyId, '+14165550177')).toEqual({
      ...NOTHING_WRITTEN,
      familyMembers: [{ role: 'primary_parent' }],
    });
    expect(wire.texts).toEqual([]);
  });

  it('seats nobody a named parent adds when the family does not hold them', async () => {
    const { familyId } = await seedFamily(PARENT, 'Barton');
    const wire = sender();
    const added = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550166',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(added).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect(await rowsFor(familyId, '+14165550166')).toEqual({
      ...NOTHING_WRITTEN,
      familyMembers: [{ role: 'primary_parent' }],
    });
    const refused = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_member_refused'));
    expect(refused).toEqual([{ after: { reason: 'seat_needs_parent_grant' } }]);
    expect(wire.texts).toEqual([]);
  });

  it('seats nobody whose channel is in this family without a family role, and seats one with a role', async () => {
    const { familyId } = await seedFamily(PARENT, 'Barton');
    const wire = sender();
    await seedMember(familyId, '+14165550166', null);
    const roleless = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550166',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(roleless).toEqual({ outcome: 'seat_needs_parent_grant' });
    expect((await rowsFor(familyId, '+14165550166')).seats).toEqual([]);

    await seedMember(familyId, '+14165550177', 'grandparent');
    const held = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550177',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(held).toMatchObject({
      outcome: 'group_member_seated',
      role: 'other_family',
      notice: 'sent',
    });
    expect((await rowsFor(familyId, '+14165550177')).seats).toHaveLength(1);
    expect(wire.texts).toEqual([await groupMemberWelcome('en', 'Barton')]);
  });

  it('welcomes in French when that is the household language', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    await db.database
      .update(schema.families)
      .set({ primaryLanguage: 'fr' })
      .where(eq(schema.families.id, seeded.familyId));
    await seedMember(seeded.familyId, '+14165550122', 'grandparent');
    const wire = sender();
    await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(wire.texts).toEqual([await groupMemberWelcome('fr', 'Barton')]);
    expect(wire.texts[0]).not.toContain('kids');
  });

  it('refuses a named stranger and a phone that already belongs to another family', async () => {
    const home = await seedFamily(PARENT, 'Barton');
    await seedFamily('+14165550888', 'Other');
    const wire = sender();
    const stranger = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550188',
      actorHandle: '+14165550999',
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(stranger).toEqual({ outcome: 'group_member_refused', reason: 'actor' });

    const other = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550888',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    expect(other).toEqual({ outcome: 'group_member_refused', reason: 'other_family' });
    expect(await liveRoles(home.familyId)).toEqual([]);
    expect(wire.texts).toEqual([]);
  });

  it('unseats on removal', async () => {
    const { familyId } = await seedFamily(PARENT, 'Barton');
    await seedMember(familyId, '+14165550199', 'grandparent');
    const wire = sender();
    await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550199',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    const removed = await unseatParticipantRemoved(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550199',
      now: NOW,
    });
    expect(removed.outcome).toBe('group_member_unseated');
    const rows = await db.database
      .select({ removedAt: schema.linqGroupMembers.removedAt })
      .from(schema.linqGroupMembers);
    expect(rows[0]?.removedAt).toEqual(NOW);
    const again = await unseatParticipantRemoved(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550199',
      now: NOW,
    });
    expect(again.outcome).toBe('group_member_absent');
  });

  it('holds a true stranger once and ledgers that send on the primary parent', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    const wire = sender();
    const first = await holdTrueStrangerOnce(db.database, {
      chatId: CHAT,
      senderHandle: '+14165550777',
      now: NOW,
      send: wire.send,
    });
    const second = await holdTrueStrangerOnce(db.database, {
      chatId: CHAT,
      senderHandle: '+14165550777',
      now: NOW,
      send: wire.send,
    });
    expect(first).toBe('sent');
    expect(second).toBe('already_sent');
    expect(wire.texts).toEqual([await groupStrangerHold('en', 'Barton')]);
    expect(wire.texts[0]).not.toContain('kids');
    const [row] = await db.database
      .select({
        parentUserId: schema.channelMessages.parentUserId,
        providerChatId: schema.channelMessages.providerChatId,
      })
      .from(schema.channelMessages);
    expect(row).toMatchObject({ parentUserId: seeded.userId, providerChatId: CHAT });
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, actor: schema.auditLog.actor })
      .from(schema.auditLog);
    expect(audits.filter((row) => row.actionTaken === 'linq_group_stranger_held')).toEqual([
      { actionTaken: 'linq_group_stranger_held', actor: seeded.userId },
    ]);
  });

  it('lets any live member take a duty and blocks privileged actions for the others', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    await seedMember(seeded.familyId, '+14165550122', 'co_parent');
    await seedMember(seeded.familyId, '+14165550133', 'grandparent');
    const wire = sender();
    await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550133',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
    });
    const seats = await db.database
      .select({
        userId: schema.linqGroupMembers.userId,
        role: schema.linqGroupMembers.role,
      })
      .from(schema.linqGroupMembers);
    const other = seats.find((row) => row.role === 'other_family');
    const withMembers = await dutyAssigneeIds(db.database, seeded.familyId);
    expect(withMembers).toEqual(expect.arrayContaining([seeded.userId, other?.userId]));
    expect(withMembers.length).toBeGreaterThanOrEqual(3);

    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'false');
    const parentsOnly = await dutyAssigneeIds(db.database, seeded.familyId);
    expect(parentsOnly).toHaveLength(2);
    expect(parentsOnly).not.toContain(other?.userId);

    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
    expect(other?.userId).toBeTruthy();
    const blocked = await declinePrivilegedGroupSeat(db.database, {
      familyId: seeded.familyId,
      userId: other?.userId as string,
      capability: 'calendar_email',
    });
    expect(blocked).toBe(true);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_member_refused'));
    expect(
      audits.some((row) => (row.after as { capability?: string }).capability === 'calendar_email'),
    ).toBe(true);
  });

  it('does nothing when the flag is off', async () => {
    await seedFamily(PARENT, 'Barton');
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'false');
    const seated = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
    });
    expect(seated.outcome).toBe('flag_off');
    const rows = await db.database
      .select({ id: schema.linqGroupMembers.id })
      .from(schema.linqGroupMembers);
    expect(rows).toEqual([]);
  });
});

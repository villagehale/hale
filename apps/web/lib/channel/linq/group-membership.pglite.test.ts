import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  retryMemberWelcome,
  seatParticipantAdded,
  unseatParticipantRemoved,
} from './group-members';
import { groupMemberByPhone, memberPlanTier, readGroupMembership } from './group-membership';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { LinqSendError } from './transport';

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

/**
 * A member the removed participant.added provisioner seated: family role, the legacy
 * group-only consent and a verified channel. A parent's add now seats only such a person.
 */
async function seedLegacyMember(phone: string) {
  const [family] = await db.database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, CHAT));
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}` })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'extended' });
  const [consent] = await db.database
    .insert(schema.consentRecords)
    .values({
      userId,
      familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'linq_group_member',
      policyVersion: POLICY_VERSION,
    })
    .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
    consentRecordId: consent?.id,
  });
}

async function seat(phone: string) {
  await seedLegacyMember(phone);
  const wire = sender();
  return seatParticipantAdded(db.database, {
    chatId: CHAT,
    participantHandle: phone,
    actorHandle: PARENT,
    isFromMe: false,
    now: NOW,
    send: wire.send,
    voice: fakeGroupOnboardingComposer(),
  });
}

describe('VIL-438 group membership read model', () => {
  it('returns null for a chat no family has claimed', async () => {
    expect(await readGroupMembership(db.database, 'chat-unknown')).toBeNull();
  });

  it('one family plan covers every seated member, with no cap', async () => {
    const { familyId } = await seedFamily(PARENT, 'Barton');
    await db.database
      .update(schema.families)
      .set({ planTier: 'family' })
      .where(eq(schema.families.id, familyId));
    const phones = ['+14165550122', '+14165550133', '+14165550144', '+14165550155', '+14165550166'];
    for (const phone of phones) {
      expect((await seat(phone)).outcome).toBe('group_member_seated');
    }
    const membership = await readGroupMembership(db.database, CHAT);
    expect(membership?.familyId).toBe(familyId);
    expect(membership?.members).toHaveLength(phones.length);
    expect(memberPlanTier(membership ?? { planTier: 'free' })).toBe('family');
    for (const phone of phones) {
      const member = await groupMemberByPhone(db.database, CHAT, phone);
      expect(member).toMatchObject({ planTier: 'family', familyId, haleCustomer: false });
    }
  });

  it('members seated only through the group are not Hale customers', async () => {
    await seedFamily(PARENT, 'Barton');
    await seat('+14165550122');
    const member = await groupMemberByPhone(db.database, CHAT, '+1 (416) 555-0122');
    expect(member?.haleCustomer).toBe(false);
  });

  it('a removed member drops out and is no longer covered', async () => {
    await seedFamily(PARENT, 'Barton');
    await seat('+14165550122');
    await seat('+14165550133');
    await unseatParticipantRemoved(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550133',
      now: NOW,
    });
    const membership = await readGroupMembership(db.database, CHAT);
    expect(membership?.members).toHaveLength(1);
    expect(await groupMemberByPhone(db.database, CHAT, '+14165550133')).toBeNull();
  });

  it('a phone that is not seated in this chat resolves to null', async () => {
    await seedFamily(PARENT, 'Barton');
    expect(await groupMemberByPhone(db.database, CHAT, '+14165550199')).toBeNull();
    expect(await groupMemberByPhone(db.database, CHAT, 'not-a-phone')).toBeNull();
  });
});

describe('VIL-438 member welcome written from facts', () => {
  it('hands the T22 facts to the voice and sends what it wrote, with no flag to set', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedLegacyMember('+14165550122');
    const voice = fakeGroupOnboardingComposer({
      body: 'Hi from Hale, Barton added you. What should I call you?',
    });
    const wire = sender();
    const result = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
      voice,
    });
    expect(result).toMatchObject({ outcome: 'group_member_seated', notice: 'sent' });
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'member_welcome',
      facts: {
        adderName: 'Barton',
        seesOnlyThisChat: true,
        noSignUpNeeded: true,
        planCoversWholeGroup: true,
        stopIsPerPersonInAnyWording: true,
      },
      wayOut: true,
      mustMention: [],
    });
    expect(wire.texts).toEqual(['Hi from Hale, Barton added you. What should I call you?']);
  });

  it('a welcome with a nickname and no question mark is not thrown out', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedLegacyMember('+14165550122');
    const body = 'Bart a ajouté Hale ici, dis-moi comment tu veux que je t’appelle';
    const wire = sender();
    const result = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
      voice: fakeGroupOnboardingComposer({ body }),
    });
    expect(result).toMatchObject({ notice: 'sent' });
    expect(wire.texts).toEqual([body]);
  });

  it('a failed voice sends nothing but keeps the seat', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedLegacyMember('+14165550122');
    const wire = sender();
    const result = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
      voice: fakeGroupOnboardingComposer({ fail: true }),
    });
    expect(result).toMatchObject({ outcome: 'group_member_seated', notice: 'not_sent' });
    expect(wire.texts).toHaveLength(0);
    expect((await readGroupMembership(db.database, CHAT))?.members).toHaveLength(1);
  });
});

const MEMBER = '+14165550122';
const LATER = new Date('2026-09-30T19:00:00.000Z');
const WELCOME = 'Hi from Hale, Barton added you. What should I call you?';

async function welcomedAt(phone: string): Promise<Date | null | undefined> {
  const [row] = await db.database
    .select({ welcomedAt: schema.linqGroupMembers.welcomedAt })
    .from(schema.linqGroupMembers)
    .where(eq(schema.linqGroupMembers.phoneE164Hash, phoneBlindIndex(phone)));
  return row?.welcomedAt;
}

/** A seat row as a given door left it. `addedBy` null is a roster (v2) seat. */
async function insertSeat(
  familyId: string,
  phone: string,
  seat: { role: 'co_parent' | 'other_family'; addedBy: string | null; removedAt?: Date },
): Promise<void> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}` })
    .returning({ id: schema.users.id });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId: user?.id as string,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: seat.role,
    addedByUserId: seat.addedBy,
    seatedAt: NOW,
    removedAt: seat.removedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function retry(
  phone: string,
  wire: ReturnType<typeof sender>,
  voice = fakeGroupOnboardingComposer(),
) {
  return retryMemberWelcome(db.database, {
    chatId: CHAT,
    senderHandle: phone,
    now: LATER,
    send: wire.send,
    voice,
  });
}

describe('VIL-461 a welcome that did not land is tried on the member’s next group message', () => {
  it('retries after the voice failed, then never again once it lands', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedLegacyMember(MEMBER);
    const wire = sender();
    const seated = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: MEMBER,
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
      voice: fakeGroupOnboardingComposer({ fail: true }),
    });
    expect(seated).toMatchObject({ outcome: 'group_member_seated', notice: 'not_sent' });
    expect(await welcomedAt(MEMBER)).toBeNull();

    const voice = fakeGroupOnboardingComposer({ body: WELCOME });
    expect(await retry(MEMBER, wire, voice)).toEqual({
      outcome: 'welcome_retried',
      notice: 'sent',
    });
    expect(wire.texts).toEqual([WELCOME]);
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'member_welcome',
      facts: { adderName: 'Barton' },
    });
    expect(await welcomedAt(MEMBER)).toEqual(LATER);

    expect(await retry(MEMBER, wire, voice)).toEqual({ outcome: 'not_owed' });
    expect(wire.texts).toHaveLength(1);
    expect(voice.calls).toHaveLength(1);
  });

  it('a send that failed is not read as delivered: the next message sends it', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedLegacyMember(MEMBER);
    const seated = await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: MEMBER,
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: async () => {
        throw new LinqSendError('timeout', 0, false);
      },
      voice: fakeGroupOnboardingComposer({ body: WELCOME }),
    });
    expect(seated).toMatchObject({ outcome: 'group_member_seated', notice: 'not_sent' });
    expect(await welcomedAt(MEMBER)).toBeNull();

    const wire = sender();
    expect(await retry(MEMBER, wire, fakeGroupOnboardingComposer({ body: WELCOME }))).toEqual({
      outcome: 'welcome_retried',
      notice: 'sent',
    });
    expect(wire.texts).toEqual([WELCOME]);
    expect(await welcomedAt(MEMBER)).toEqual(LATER);
    const ledger = await db.database
      .select({
        status: schema.channelMessages.status,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, 'linq:group_member_welcome'));
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((row) => row.status === 'failed')).toHaveLength(1);
    expect(ledger.filter((row) => row.providerMessageId === 'msg-1')).toHaveLength(1);
  });

  it('owes no welcome to a co-parent, a roster seat, a removed seat, or a stranger', async () => {
    const { familyId, userId } = await seedFamily(PARENT, 'Barton');
    await insertSeat(familyId, '+14165550133', { role: 'co_parent', addedBy: userId });
    await insertSeat(familyId, '+14165550144', { role: 'other_family', addedBy: null });
    await insertSeat(familyId, '+14165550155', {
      role: 'other_family',
      addedBy: userId,
      removedAt: NOW,
    });
    await insertSeat(familyId, '+14165550166', { role: 'other_family', addedBy: userId });
    const wire = sender();
    for (const phone of ['+14165550133', '+14165550144', '+14165550155', '+14165550177']) {
      expect(await retry(phone, wire)).toEqual({ outcome: 'not_owed' });
    }
    expect(wire.texts).toEqual([]);
    expect(await retry('+14165550166', wire)).toEqual({
      outcome: 'welcome_retried',
      notice: 'sent',
    });
    expect(wire.texts).toHaveLength(1);
  });

  it('does nothing when the members flag is off', async () => {
    const { familyId, userId } = await seedFamily(PARENT, 'Barton');
    await insertSeat(familyId, MEMBER, { role: 'other_family', addedBy: userId });
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', '');
    const wire = sender();
    expect(await retry(MEMBER, wire)).toEqual({ outcome: 'flag_off' });
    expect(wire.texts).toEqual([]);
  });
});

import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { seatParticipantAdded, unseatParticipantRemoved } from './group-members';
import { groupMemberWelcome } from './group-members';
import { groupMemberByPhone, memberPlanTier, readGroupMembership } from './group-membership';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';

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

async function seat(phone: string) {
  const wire = sender();
  return seatParticipantAdded(db.database, {
    chatId: CHAT,
    participantHandle: phone,
    actorHandle: PARENT,
    isFromMe: false,
    now: NOW,
    send: wire.send,
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
  it('flag off keeps the fixed welcome and never calls the voice', async () => {
    await seedFamily(PARENT, 'Barton');
    const voice = fakeGroupOnboardingComposer();
    const wire = sender();
    await seatParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      actorHandle: PARENT,
      isFromMe: false,
      now: NOW,
      send: wire.send,
      voice,
    });
    expect(voice.calls).toHaveLength(0);
    expect(wire.texts).toEqual([groupMemberWelcome('en', 'Barton')]);
  });

  it('flag on hands the T22 facts to the voice and sends what it wrote', async () => {
    vi.stubEnv('LINQ_GROUP_WELCOME_VOICE_ENABLED', 'true');
    await seedFamily(PARENT, 'Barton');
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
    });
    expect(wire.texts).toEqual(['Hi from Hale, Barton added you. What should I call you?']);
  });

  it('flag on with a failed voice sends nothing but keeps the seat', async () => {
    vi.stubEnv('LINQ_GROUP_WELCOME_VOICE_ENABLED', 'true');
    await seedFamily(PARENT, 'Barton');
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

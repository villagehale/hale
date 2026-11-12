import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { considerGroupExperience } from './inbound';
import type { GroupExperienceReading } from './reading';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-399 privacy rule through the production wiring (considerGroupExperience builds the
 * deny list the way the live door does): nothing from one family's calendar or kids
 * reaches a shared group line, and a private question is only ever moved to the asking
 * household's own 1:1.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-exp-privacy';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const CALENDAR_TITLE = 'Dentist checkup';
const CHILD = 'Zephyrina';

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
  vi.stubEnv('GROUP_LINK_CARDS_ENABLED', 'true');
  vi.stubEnv('GROUP_PRIVATE_QUESTION_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_group_experience, audit_log cascade',
  );
});

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId: CHAT,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    userId,
    firstName: name,
  });
  return { familyId, userId };
}

async function twoFamilies() {
  const a = await seedFamily(PARENT_A, 'Ada');
  const b = await seedFamily(PARENT_B, 'Bao');
  await db.database.insert(schema.children).values({
    familyId: b.familyId,
    name: CHILD,
    dateOfBirth: '2021-05-01',
  });
  await db.database.insert(schema.familyEvents).values({
    familyId: b.familyId,
    title: CALENDAR_TITLE,
    startsAt: new Date('2026-11-14T15:00:00.000Z'),
    source: 'parent',
  });
  return { a, b };
}

function reading(partial: Partial<GroupExperienceReading>): GroupExperienceReading {
  return {
    kind: 'none',
    title: null,
    response: null,
    optionKey: null,
    options: [],
    starts: [],
    confidence: 'high',
    ...partial,
  };
}

function wire() {
  const group: string[] = [];
  const oneToOne: { familyId: string; text: string }[] = [];
  return {
    group,
    oneToOne,
    send: async ({ text }: { chatId: string; text: string }) => {
      group.push(text);
      return { providerMessageId: `g-${group.length}` };
    },
    sendOneToOne: async (input: { familyId: string; text: string }) => {
      oneToOne.push({ familyId: input.familyId, text: input.text });
      return 'sent' as const;
    },
  };
}

describe('VIL-399 group lines through the production deny list', () => {
  const linkTurn = async (line: string) => {
    const { a } = await twoFamilies();
    const w = wire();
    const out = await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: w.send,
        sendOneToOne: w.sendOneToOne,
        reader: { read: async () => reading({ kind: 'link_facts' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => (input.audience === 'group' ? line : 'registration here'),
        }),
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_A,
        senderUserId: a.userId,
        senderFamilyId: a.familyId,
        coveringFamilyId: a.familyId,
        text: 'this camp https://park.example/camp is $120 for two sessions',
      },
    );
    return { out, w };
  };

  it("never posts another family's calendar title in the group", async () => {
    const { out, w } = await linkTurn(`Camp is $120, two sessions. ${CALENDAR_TITLE} clash.`);
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_line_unsent' });
    expect(w.group).toEqual([]);
  });

  it("never posts another family's child in the group", async () => {
    const { out, w } = await linkTurn(`Camp is $120, two sessions. ${CHILD} would love it.`);
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_line_unsent' });
    expect(w.group).toEqual([]);
  });

  it('positive control: a public-facts line still goes to the group', async () => {
    const { out, w } = await linkTurn('Camp is $120 for two sessions.');
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(w.group).toEqual(['Camp is $120 for two sessions.']);
  });
});

describe('VIL-399 a private question goes to the asking household only', () => {
  const privateTurn = async (sender: { userId: string | null; familyId: string | null }) => {
    const { a } = await twoFamilies();
    const w = wire();
    const out = await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: w.send,
        sendOneToOne: w.sendOneToOne,
        reader: { read: async () => reading({ kind: 'private_question' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => (input.kind === 'private_hold' ? 'I will text you.' : 'one to one'),
        }),
      },
      {
        chatId: CHAT,
        senderHandle: '+15555550199',
        senderUserId: sender.userId,
        senderFamilyId: sender.familyId,
        coveringFamilyId: a.familyId,
        text: 'what is the address for pickup?',
      },
    );
    return { out, w, a };
  };

  it('a sender with no Hale household gets no 1:1 sent to some other family', async () => {
    const { out, w } = await privateTurn({ userId: null, familyId: null });
    expect(w.oneToOne).toEqual([]);
    // Nothing promises a text that will never come.
    expect(w.group).toEqual([]);
    expect(out).toMatchObject({
      handled: true,
      outcome: 'group_experience_line_unsent',
      notice: { skipped: 'asker_unknown' },
    });
  });

  it('a household that is not in this chat is not swapped for one that is', async () => {
    const [outsider] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Cy', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const { w } = await privateTurn({ userId: null, familyId: outsider?.id as string });
    expect(w.oneToOne).toEqual([]);
    expect(w.group).toEqual([]);
  });

  it("positive control: the asker's own household hears it 1:1", async () => {
    const fresh = await twoFamilies();
    const w = wire();
    const out = await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: w.send,
        sendOneToOne: w.sendOneToOne,
        reader: { read: async () => reading({ kind: 'private_question' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => (input.kind === 'private_hold' ? 'I will text you.' : 'one to one'),
        }),
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_B,
        senderUserId: fresh.b.userId,
        senderFamilyId: fresh.b.familyId,
        coveringFamilyId: fresh.a.familyId,
        text: `is ${CHILD} allergic to anything in the snack?`,
      },
    );
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_1to1' });
    expect(w.group).toEqual(['I will text you.']);
    expect(w.oneToOne).toEqual([{ familyId: fresh.b.familyId, text: 'one to one' }]);
  });
});

describe('VIL-399 every group line is an audit row', () => {
  it('writes sms_reply_sent with the ledgered body when a group line lands', async () => {
    const { a } = await twoFamilies();
    // A consented shared group is what lets an event_logistics line past the floor.
    await db.database
      .insert(schema.linqMultiFamilyJoins)
      .values({ chatId: CHAT, familyId: a.familyId, joinedByUserId: a.userId, joinedAt: NOW });
    const { sendGroupExperienceLine } = await import('./send');
    await sendGroupExperienceLine(db.database, {
      chatId: CHAT,
      familyId: a.familyId,
      text: 'Camp is $120 for two sessions.',
      now: NOW,
      send: async () => ({ providerMessageId: 'out-audit' }),
      listChatHandles: async () => ({
        status: 'ok',
        handles: [PARENT_A, PARENT_B],
        isGroup: true,
      }),
    });
    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerChatId, CHAT));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.body).toBe('Camp is $120 for two sessions.');
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'sms_reply_sent'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBe(ledger[0]?.id);
    expect(rows[0]?.familyId).toBe(a.familyId);
  });
});

describe('VIL-399 each household 1:1 from a group link goes through the audited 1:1 door', () => {
  it('texts each household parent once, each with its own sms_reply_sent row', async () => {
    const { a, b } = await twoFamilies();
    for (const [family, phone] of [
      [a, PARENT_A],
      [b, PARENT_B],
    ] as const) {
      await db.database.insert(schema.parentChannels).values({
        userId: family.userId,
        familyId: family.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: phoneBlindIndex(phone),
        verifiedAt: NOW,
      });
    }
    const texted: string[] = [];
    const w = wire();
    await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: w.send,
        oneToOne: {
          text: async ({ to }) => {
            texted.push(to);
            return { providerMessageId: `dm-${texted.length}`, chatId: `dm-chat-${texted.length}` };
          },
          link: async () => ({ providerMessageId: 'unused' }),
        },
        reader: { read: async () => reading({ kind: 'link_facts' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) =>
            input.audience === 'group' ? 'Camp is $120.' : 'I can sign you up from here.',
        }),
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_A,
        senderUserId: a.userId,
        senderFamilyId: a.familyId,
        coveringFamilyId: a.familyId,
        text: 'this camp https://park.example/camp is $120',
      },
    );
    expect(texted.sort()).toEqual([PARENT_A, PARENT_B].sort());
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'sms_reply_sent'));
    expect(rows.map((row) => [row.familyId, row.actor, row.targetTable]).sort()).toEqual(
      [
        [a.familyId, a.userId, 'channel_messages'],
        [b.familyId, b.userId, 'channel_messages'],
      ].sort(),
    );
  });
});

import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { PrivateAsideModel } from '../group-private-aside';
import { handleLinqGroupMessage } from '../inbound';
import type { SharedGroupIntent, SharedGroupReader } from '../shared-group-reading';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import type { GroupExperienceKind, GroupExperienceReading } from './reading';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-399 through the real group door with every group flag on (the launch set): in a
 * chat several families share, the group moments (a posted link, an RSVP, a time lock, a
 * private question) get their turn before Hale's plain shared-chat answer, and each
 * message is read for them once.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-exp-door';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const FROM = '+15555550100';
const SHARED_REPLY = 'shared-reply-line';

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
  for (const flag of [
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_group_experience, channel_messages, audit_log cascade',
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
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId, joinedByUserId: userId, joinedAt: NOW });
  return { familyId, userId };
}

const sharedReader = (intent: SharedGroupIntent): SharedGroupReader => ({
  async read() {
    return { intent, role: 'unclear', familyLabel: null, kidName: null, confidence: 'high' };
  },
});

const noAside: PrivateAsideModel = {
  async read() {
    return [];
  },
  async draft() {
    return { send: false, about: '', text: '' };
  },
};

function experienceReader(kind: GroupExperienceKind) {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async read(input: { text: string }): Promise<GroupExperienceReading> {
        reads.push(input.text);
        return {
          kind,
          title: null,
          samePlan: null,
          response: null,
          optionKey: null,
          options: [],
          starts: [],
          confidence: 'high',
        };
      },
    },
  };
}

async function say(
  text: string,
  shared: SharedGroupIntent,
  kind: GroupExperienceKind,
): Promise<{ body: Record<string, unknown>; group: string[]; dm: string[]; reads: string[] }> {
  const group: string[] = [];
  const dm: string[] = [];
  const exp = experienceReader(kind);
  const response = await handleLinqGroupMessage(
    {
      database: db.database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      enqueue: async () => {},
      now: () => NOW,
      sendGroupText: async ({ text: line }: { chatId: string; text: string }) => {
        group.push(line);
        return { providerMessageId: `g-${group.length}` };
      },
      oneToOne: {
        text: async ({ to }: { to: string; body: string }) => {
          dm.push(to);
          return { providerMessageId: `dm-${dm.length}`, chatId: `dm-${dm.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
      listChatHandles: async () => ({ status: 'ok', handles: [PARENT_A, PARENT_B] }),
      sharedGroupReader: sharedReader(shared),
      sharedGroupVoice: fakeSharedGroupComposer({ body: SHARED_REPLY }),
      privateAsideModel: noAside,
      groupExperienceReader: exp.reader,
      groupExperienceComposer: fakeGroupExperienceComposer({
        body: (input) =>
          input.audience === 'group' ? `moment:${input.kind}` : `one-to-one:${input.kind}`,
      }),
    } as unknown as Parameters<typeof handleLinqGroupMessage>[0],
    {
      messageId: `in-${text.length}`,
      chatId: CHAT,
      senderHandle: PARENT_A,
      text,
      mediaCount: 0,
      receivedAt: NOW,
      otherHandles: [PARENT_B],
      mentions: [],
      isGroup: true,
    },
  );
  return { body: (await response.json()) as Record<string, unknown>, group, dm, reads: exp.reads };
}

describe('VIL-399 group moments in a chat several families share', () => {
  it('a posted link says its public facts and takes registration 1:1, not the plain answer', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const out = await say(
      'anyone want this? https://park.example/camp $120 two sessions',
      'question',
      'link_facts',
    );
    expect(out.group).toEqual(['moment:link_facts']);
    expect(out.dm.sort()).toEqual([PARENT_A, PARENT_B].sort());
    expect(out.body).toMatchObject({ outcome: 'group_experience_spoken' });
    expect(out.reads).toHaveLength(1);
  });

  it('a private question moves to the asker 1:1 and is not answered in the group', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const out = await say(
      'does the snack have peanuts? Mira is allergic',
      'question',
      'private_question',
    );
    expect(out.group).toEqual(['moment:private_hold']);
    expect(out.dm).toEqual([PARENT_A]);
    expect(out.reads).toHaveLength(1);
  });

  it('positive control: plain chatter for neither still gets the shared answer once', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const out = await say('what time is practice again?', 'question', 'none');
    expect(out.group).toEqual([SHARED_REPLY]);
    expect(out.dm).toEqual([]);
    expect(out.reads).toHaveLength(1);
  });
});

import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { DROP_SINGLE_OPEN_PLAN_INDEX, seedTextedHale } from '~/lib/testing/group-scenes';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { considerGroupPlanRsvp } from './inbound';
import type { GroupPlanRsvpReading } from './reading';
import { createPostgresGroupPlanRsvpStore } from './store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-689 · a new poll replaces the chat's live poll, so it opens only once its line has
 * landed. A line the floor held or Linq refused leaves the poll people are voting on.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-poll-opening';
const NOW = new Date('2026-11-12T17:00:00.000Z');
const PHONE = '+15555550151';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  await db.exec(DROP_SINGLE_OPEN_PLAN_INDEX);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_group_plans, linq_group_polls, audit_log, channel_messages cascade',
  );
});

async function householdWithLivePoll() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Home', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:pat', name: 'Pat', timezone: 'America/Toronto' })
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
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
  });
  await seedTextedHale(db.database, { familyId, userId, at: new Date(NOW.getTime() - 9e7) });
  const store = createPostgresGroupPlanRsvpStore(db.database);
  const first = await store.createPoll({
    chatId: CHAT,
    familyId,
    question: 'pizza or tacos',
    options: [
      { text: 'pizza', providerOptionId: null },
      { text: 'tacos', providerOptionId: null },
    ],
    expected: [],
    origin: 'parent',
    providerMessageId: null,
    now: NOW,
  });
  return { userId, store, first };
}

const startSecondPoll: GroupPlanRsvpReading = {
  intent: 'start_poll',
  response: null,
  headcount: 1,
  planTitle: null,
  startsAt: null,
  location: null,
  deadline: null,
  householdLabel: null,
  coversNames: [],
  confidence: 'high',
  planKey: null,
  replacesPlanKey: null,
  addressed: true,
  pollQuestion: 'park or zoo',
  pollOptions: ['park', 'zoo'],
  pollStarts: [null, null],
  pollChoice: null,
} as GroupPlanRsvpReading;

async function askForSecondPoll(
  userId: string,
  send: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>,
) {
  return considerGroupPlanRsvp(
    {
      database: db.database,
      now: NOW,
      reader: { read: async () => startSecondPoll },
      composer: fakeGroupPlanRsvpComposer(),
      send,
    },
    {
      chatId: CHAT,
      senderHandle: PHONE,
      senderUserId: userId,
      text: 'poll: park or zoo',
      tapback: null,
    },
  );
}

async function pollRows() {
  return db.database
    .select({
      id: schema.linqGroupPolls.id,
      question: schema.linqGroupPolls.question,
      closedAt: schema.linqGroupPolls.closedAt,
    })
    .from(schema.linqGroupPolls)
    .where(eq(schema.linqGroupPolls.chatId, CHAT));
}

describe('a second poll in a chat with a live poll', () => {
  it('whose line never lands leaves the live poll open, and opens nothing', async () => {
    const { userId, store, first } = await householdWithLivePoll();
    const out = await askForSecondPoll(userId, async () => {
      throw new Error('held by the family-chat floor');
    });
    expect(out).toMatchObject({ handled: true, outcome: 'group_poll_line_unsent' });
    expect((await store.loadLivePoll(CHAT))?.id).toBe(first.id);
    expect(await pollRows()).toHaveLength(1);
  });

  it('positive control: whose line lands replaces the live poll', async () => {
    const { userId, store, first } = await householdWithLivePoll();
    const said: string[] = [];
    const out = await askForSecondPoll(userId, async ({ text }) => {
      said.push(text);
      return { providerMessageId: 'out-1' };
    });
    expect(out).toMatchObject({ handled: true, outcome: 'group_poll_spoken' });
    expect(said).toHaveLength(1);
    const live = await store.loadLivePoll(CHAT);
    expect(live?.question).toBe('park or zoo');
    expect(live?.id).not.toBe(first.id);
    const rows = await pollRows();
    expect(rows.find((row) => row.id === first.id)?.closedAt).toEqual(NOW);
  });
});

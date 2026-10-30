import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { considerGroupPlanRsvp, considerGroupPollCardVote, postgresGroupPollCard } from './inbound';
import { memberKeyFromHandle } from './member-key';
import { GROUP_STUCK_POLL_KIND } from './poll-turn';
import type { GroupPlanRsvpReading } from './reading';
import { createPostgresGroupPlanRsvpStore } from './store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-471 on Postgres: migration 0190, the store, and the inbound adapters.
 * Linq, Anthropic, and DB keys are unset — the reader and composer are
 * structured stand-ins and nothing reaches Linq.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT = '+14165550111';
const NOT_HALE = '+14165550199';
const CHAT = 'chat-pglite-poll';
const NOW = new Date('2026-10-28T16:00:00.000Z');

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
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedFamily() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Patel', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:Priya', name: 'Priya Patel', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId,
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    role: 'parent',
    seatedAt: NOW,
  });
  return { familyId, userId };
}

function startReading(): GroupPlanRsvpReading {
  return {
    intent: 'start_poll',
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response: null,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
    pollQuestion: 'where Saturday',
    pollOptions: ['zoo', 'museum'],
    pollChoice: null,
  };
}

async function actions() {
  const rows = await db.database
    .select({ action: schema.auditLog.actionTaken })
    .from(schema.auditLog);
  return rows.map((row) => row.action);
}

describe('postgres group poll store', () => {
  it('opens one live poll per chat, upserts a changed vote, and clears only the current pick', async () => {
    const { familyId } = await seedFamily();
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const first = await store.createPoll({
      chatId: CHAT,
      familyId,
      question: 'where',
      options: [
        { text: 'zoo', providerOptionId: null },
        { text: 'museum', providerOptionId: null },
      ],
      expected: [{ memberKey: 'k-priya', displayName: 'Priya' }],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    expect(first.options.map((option) => option.key)).toEqual(['o1', 'o2']);

    const vote = {
      pollId: first.id,
      memberKey: 'k-dev',
      displayName: 'Dev',
      userId: null,
      haleCustomer: false,
      optionKey: 'o1',
      source: 'text' as const,
      now: NOW,
    };
    expect(await store.recordPollVote(vote)).toEqual({ changed: true });
    expect(await store.recordPollVote(vote)).toEqual({ changed: false });
    expect(await store.recordPollVote({ ...vote, optionKey: 'o2', source: 'native' })).toEqual({
      changed: true,
    });
    const tally = await store.loadPollTally(first.id);
    expect(tally.options.map((option) => option.votes)).toEqual([0, 1]);
    expect(tally.waitingNames).toEqual(['Priya']);

    expect(
      await store.clearPollVote({
        pollId: first.id,
        memberKey: 'k-dev',
        optionKey: 'o1',
        now: NOW,
      }),
    ).toEqual({ cleared: false });
    expect(
      await store.clearPollVote({
        pollId: first.id,
        memberKey: 'k-dev',
        optionKey: 'o2',
        now: NOW,
      }),
    ).toEqual({ cleared: true });

    const second = await store.createPoll({
      chatId: CHAT,
      familyId,
      question: null,
      options: [
        { text: 'a', providerOptionId: null },
        { text: 'b', providerOptionId: null },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    expect((await store.loadLivePoll(CHAT))?.id).toBe(second.id);
    const rows = await db.database.select().from(schema.linqGroupPolls);
    expect(rows.filter((row) => row.closedAt === null)).toHaveLength(1);

    const votes = await db.database.select().from(schema.linqGroupPollVotes);
    expect(Object.keys(votes[0] ?? {})).not.toContain('verbatim');
    expect(await actions()).toEqual(
      expect.arrayContaining([
        'linq_group_poll_started',
        'linq_group_poll_vote_recorded',
        'linq_group_poll_vote_removed',
      ]),
    );
  });
});

describe('group poll inbound adapters', () => {
  it('opens a parent poll through the ledgered send; the card is named not_configured with Linq unset', async () => {
    vi.stubEnv('LINQ_POLLS', 'on');
    await seedFamily();
    const sent: string[] = [];
    const result = await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
        send: async ({ text }) => {
          sent.push(text);
          return { providerMessageId: 'line-1' };
        },
        reader: { read: async () => startReading() },
        composer: fakeGroupPlanRsvpComposer(),
      },
      { chatId: CHAT, senderHandle: PARENT, text: 'a group message', tapback: null },
    );
    expect(result.handled && result.outcome).toBe('group_poll_spoken');
    expect(result.handled && result.card).toEqual({ skipped: 'not_configured' });
    expect(sent).toHaveLength(1);
    const [poll] = await db.database.select().from(schema.linqGroupPolls);
    expect(poll?.origin).toBe('parent');
    expect(poll?.expected).toEqual([
      { memberKey: memberKeyFromHandle(PARENT), displayName: 'Priya' },
    ]);
  });

  it('names polls_off on the card when LINQ_POLLS is off', async () => {
    vi.stubEnv('LINQ_POLLS', '');
    const { familyId } = await seedFamily();
    const card = postgresGroupPollCard(db.database);
    expect(card.enabled()).toBe(false);
    expect(await card.send({ chatId: CHAT, familyId, pollId: 'p', options: [], now: NOW })).toEqual(
      { status: 'skipped', reason: 'polls_off' },
    );
  });

  it('adopts a VIL-458 stuck-group card from linq_poll_options on the first tap, for a non-Hale voter', async () => {
    const { familyId, userId } = await seedFamily();
    await db.database.insert(schema.linqPollOptions).values([
      {
        familyId,
        parentUserId: userId,
        providerChatId: CHAT,
        providerMessageId: 'stuck-msg',
        optionId: 'stuck-sat',
        optionText: 'Sat 10am',
        pollKind: GROUP_STUCK_POLL_KIND,
      },
      {
        familyId,
        parentUserId: userId,
        providerChatId: CHAT,
        providerMessageId: 'stuck-msg',
        optionId: 'stuck-sun',
        optionText: 'Sun 2pm',
        pollKind: GROUP_STUCK_POLL_KIND,
      },
    ]);
    const card = {
      providerMessageId: 'stuck-msg',
      familyId,
      pollKind: GROUP_STUCK_POLL_KIND,
      subjectKey: null,
    };
    const ports = {
      database: db.database,
      now: NOW,
      send: async () => ({ providerMessageId: 'never' }),
      composer: fakeGroupPlanRsvpComposer(),
    };
    const vote = await considerGroupPollCardVote(ports, {
      chatId: CHAT,
      senderHandle: NOT_HALE,
      event: 'added',
      optionId: 'stuck-sun',
      card,
    });
    expect(vote.handled && vote.outcome).toBe('group_poll_recorded');
    const polls = await db.database.select().from(schema.linqGroupPolls);
    expect(polls).toHaveLength(1);
    expect(polls[0]?.origin).toBe('hale_offer');
    expect(polls[0]?.providerMessageId).toBe('stuck-msg');

    const parentVote = await considerGroupPollCardVote(ports, {
      chatId: CHAT,
      senderHandle: PARENT,
      event: 'added',
      optionId: 'stuck-sun',
      card,
    });
    expect(parentVote.handled && parentVote.outcome).toBe('group_poll_spoken');
    expect(
      parentVote.handled && parentVote.pollTally?.options.find((o) => o.text === 'Sun 2pm')?.votes,
    ).toBe(2);
    expect(await db.database.select().from(schema.linqGroupPolls)).toHaveLength(1);

    const votes = await db.database
      .select()
      .from(schema.linqGroupPollVotes)
      .where(eq(schema.linqGroupPollVotes.pollId, polls[0]?.id as string));
    expect(votes.map((row) => row.source)).toEqual(['native', 'native']);
  });

  it('is dark with LINQ_GROUP_POLLS_ENABLED off', async () => {
    vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', '');
    const { familyId } = await seedFamily();
    const vote = await considerGroupPollCardVote(
      { database: db.database, now: NOW },
      {
        chatId: CHAT,
        senderHandle: NOT_HALE,
        event: 'added',
        optionId: 'x',
        card: {
          providerMessageId: 'm',
          familyId,
          pollKind: GROUP_STUCK_POLL_KIND,
          subjectKey: null,
        },
      },
    );
    expect(vote).toEqual({ handled: false });
  });
});

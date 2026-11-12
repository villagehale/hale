import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import type { ListChatHandles } from '~/lib/channel/linq/roster';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  ACTIVITY_FOLLOWUP_DUE_HOURS,
  defaultActivityPromisePorts,
  recordActivityPromise,
} from './commitment';
import { type DeepJobDeps, defaultDeepJobDeps, runDeepResearchJob } from './deep-job';
import { type DeepDispatchOutcome, dispatchDepthForPromise } from './deep-queue';
import {
  type ActivityFollowUpDeps,
  defaultActivityFollowUpDeps,
  runActivityFollowUpSweep,
} from './sweep';

/**
 * WHEN AND WHERE "I'LL COME BACK TO YOU" IS ANSWERED, over the real ledger, the real
 * recipient resolver and the real delivery. Only the transport, the outbound gate's reads,
 * the web, and the composer's words are ports here: the words are the eval's job (rule #8).
 *
 * The household has a claimed group with a confirmed roster and an asking parent who
 * wrote in Chinese from their 1:1 chat while their stored language is Spanish, so every
 * wrong landing gives a different answer.
 */

const NOW = new Date('2026-11-10T15:05:00.000Z');
const ASKED_AT = new Date('2026-11-10T15:00:00.000Z');
const CARRIED_AT = new Date('2026-11-10T15:01:00.000Z');
const PHONE = '+15555550121';
const CO_PARENT = '+15555550122';
const HOME_GROUP = 'chat-home';
const ONE_TO_ONE = 'chat-one';
const ASK_ID = 'msg-the-ask';
const PAGE_URL = 'https://cartwheelsgymcentre.example/programs';
const PAGE_TEXT =
  'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26. $124 per term. Registration has been open since July 22.';
const BODY = 'Tiny Gym runs Sundays 9:30.';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64'));
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('LINQ_FROM_E164', '+15555550120');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec('truncate table families, users cascade');
});

const openGate: OutboundGatePorts = {
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => 'America/Toronto',
};

/** Every Linq call this test makes, and none of them leaves the process. */
function linqWire(): { posted: string[] } {
  const posted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(String(url));
      return new Response(JSON.stringify({ message: { id: 'linq-out-1' } }), { status: 201 });
    }),
  );
  return { posted };
}

/** The household, its confirmed group, and a promise carried in the asking parent's 1:1. */
async function household(): Promise<SeededFamily & { carriedBy: string }> {
  const seeded = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ primaryLanguage: 'fr', linqGroupChatId: HOME_GROUP })
    .where(eq(schema.families.id, seeded.familyId));
  await db.database
    .update(schema.users)
    .set({ proactiveLanguage: 'es' })
    .where(eq(schema.users.id, seeded.parentUserId));
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({
      chatId: HOME_GROUP,
      familyId: seeded.familyId,
      source: 'added_to_existing',
      status: 'confirmed',
    })
    .returning({ id: schema.linqGroupRosters.id });
  for (const [phone, status, confirmedRole] of [
    [PHONE, 'known_parent', null],
    [CO_PARENT, 'confirmed', 'co_parent'],
  ] as const) {
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: HOME_GROUP,
      phoneE164Hash: phoneBlindIndex(phone),
      status,
      confirmedRole,
    });
  }
  const thread = {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'imessage',
    category: 'reply',
    providerChatId: ONE_TO_ONE,
  } as const;
  await db.database.insert(schema.channelMessages).values({
    ...thread,
    direction: 'in',
    status: 'delivered',
    providerMessageId: ASK_ID,
    inGroup: false,
    createdAt: ASKED_AT,
  });
  const [carried] = await db.database
    .insert(schema.channelMessages)
    .values({
      ...thread,
      direction: 'out',
      status: 'sent',
      providerMessageId: 'msg-carried',
      sentAt: CARRIED_AT,
      createdAt: CARRIED_AT,
    })
    .returning({ id: schema.channelMessages.id });
  return { ...seeded, carriedBy: carried?.id as string };
}

/** The router's two steps after the reply went: write the promise down, then dispatch. */
async function promised(
  seeded: SeededFamily & { carriedBy: string },
): Promise<{ id: string; outcome: DeepDispatchOutcome; dispatched: number }> {
  const recorded = await recordActivityPromise(
    db.database,
    {
      familyId: seeded.familyId,
      promise: { subject: 'Cartwheels Gym Centre fall schedule', childId: null },
      channelMessageId: seeded.carriedBy,
      askLanguage: 'zh',
      now: NOW,
    },
    defaultActivityPromisePorts(),
  );
  if (recorded.status !== 'recorded') throw new Error(`not recorded: ${recorded.reason}`);
  const dispatched: unknown[] = [];
  const outcome = await dispatchDepthForPromise(
    async (payload) => {
      dispatched.push(payload);
      return { status: 'enqueued' };
    },
    { familyId: seeded.familyId, parentUserId: seeded.parentUserId, recorded },
  );
  return { id: recorded.commitmentId, outcome, dispatched: dispatched.length };
}

function delivery(
  transport: FakeTransport,
  composed: Array<{ language: string }>,
): ActivityFollowUpDeps {
  return {
    ...defaultActivityFollowUpDeps(),
    reader: {
      place: async () => ({ status: 'known', town: 'Halton Hills' }),
      stage: async () => 'toddler',
      householdNames: async () => [],
    },
    finder: {
      async find() {
        return {
          found: true,
          picks: [
            {
              name: 'Tiny Gym, Cartwheels Gym Centre',
              ageFit: 'walking to 3.5 years',
              when: 'Sundays 9:30-10:15',
              price: '$124 per term',
              sourceName: 'Cartwheels Gym Centre',
              source: 'web',
            },
          ],
        };
      },
    },
    deep: {
      async research() {
        return { status: 'unavailable', reason: 'client_unavailable' };
      },
    },
    composer: {
      async compose(grounding) {
        composed.push(grounding);
        return { status: 'composed', message: BODY, mentionsWatch: false };
      },
    },
    buildGate: () => openGate,
    resolveSendablePhone: async () => PHONE,
    transport,
  };
}

/** The lane's two ports, scripted to one quote-backed row; the refutation runs for real. */
const lane: DeepJobDeps['lane'] = {
  researcher: {
    async research(_query, angle) {
      return {
        angle,
        status: 'read',
        searchResults: 4,
        pagesRead: 1,
        pagesStale: 0,
        pagesRefused: 0,
        pages: [{ url: PAGE_URL, text: PAGE_TEXT }],
        notes: PAGE_TEXT,
        pagesTruncated: 0,
        reason: null,
      };
    },
  },
  synthesiser: {
    async merge() {
      return {
        status: 'synthesised',
        rows: [
          {
            name: 'Tiny Gym, Cartwheels Gym Centre',
            age_fit: 'walking to 3.5 years',
            when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
            when_quote: 'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26',
            price: '$124 per term',
            price_quote: '$124 per term',
            registration: 'Open since July 22',
            registration_quote: 'Registration has been open since July 22',
            source_name: 'Cartwheels Gym Centre',
            source_url: PAGE_URL,
          },
        ],
      };
    },
  },
};

async function openPromises(familyId: string) {
  return db.database
    .select({ id: schema.agentCommitments.id, fulfilledAt: schema.agentCommitments.fulfilledAt })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, familyId));
}

describe('deep-followup-now dark: the hourly sweep keeps the promise, as before #1251', () => {
  it('queues nothing at question time, sends nothing within the day, and answers at the due time, unthreaded, in the stored language', async () => {
    const http = linqWire();
    const seeded = await household();
    // Positive control: this household's group is claimed and open to a schedule line.
    const present: ListChatHandles = async () => ({
      status: 'ok',
      handles: [PHONE, CO_PARENT],
      isGroup: true,
    });
    await expect(
      familyOutboundTarget(db.database, seeded.familyId, {
        contentClass: 'schedule',
        listChatHandles: present,
      }),
    ).resolves.toMatchObject({ channel: 'group', chatId: HOME_GROUP });

    const dispatch = await promised(seeded);
    expect(dispatch.outcome).toEqual({ status: 'not_enqueued', reason: 'followup_now_dark' });
    expect(dispatch.dispatched).toBe(0);

    const transport = new FakeTransport();
    const composed: Array<{ language: string }> = [];
    const deps = delivery(transport, composed);

    const anHourOn = new Date(NOW.getTime() + 3_600_000);
    const early = await runActivityFollowUpSweep(db.database, deps, anHourOn);
    expect(early.due).toBe(0);
    expect(transport.sent).toEqual([]);

    const due = new Date(NOW.getTime() + ACTIVITY_FOLLOWUP_DUE_HOURS * 3_600_000);
    const kept = await runActivityFollowUpSweep(db.database, deps, due);
    expect(kept.sent).toBe(1);
    // Hand-derived from the delivery before #1251: no reply thread, and the target is the
    // family router's pick for an unclassified line, which the household floor keeps out
    // of the group (group-audience.ts), so the parent's own number.
    expect(transport.sent).toEqual([expect.objectContaining({ to: PHONE, body: BODY })]);
    expect(transport.sent[0]).not.toHaveProperty('replyIn');
    expect(http.posted).toEqual([]);
    expect(composed.map((grounding) => grounding.language)).toEqual(['es']);
    expect(await openPromises(seeded.familyId)).toEqual([
      { id: dispatch.id, fulfilledAt: expect.any(Date) },
    ]);
  });
});

describe('deep-followup-now lit: #1251, answered in minutes', () => {
  it("queues the deep pass, and its answer goes out on the immediate lane, threaded under the ask in the 1:1, in the ask's language", async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    // Live cadence holds every candidate for the hourly decider; the immediate lane does not wait.
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const http = linqWire();
    const seeded = await household();

    const dispatch = await promised(seeded);
    expect(dispatch.outcome).toEqual({ status: 'enqueued' });
    expect(dispatch.dispatched).toBe(1);

    const transport = new FakeTransport();
    const composed: Array<{ language: string }> = [];
    const minutesOn = new Date(NOW.getTime() + 4 * 60_000);
    const sweep = delivery(transport, composed);
    const deps: DeepJobDeps = {
      ...defaultDeepJobDeps(),
      reader: sweep.reader,
      buildGate: () => openGate,
      lane,
      delivery: sweep,
      clock: () => minutesOn,
    };

    const outcome = await runDeepResearchJob(
      db.database,
      { commitment_id: dispatch.id, family_id: seeded.familyId },
      deps,
      minutesOn,
    );

    expect(outcome).toMatchObject({ status: 'sent' });
    expect(transport.sent).toEqual([
      expect.objectContaining({
        to: PHONE,
        replyIn: { chatId: ONE_TO_ONE, messageId: ASK_ID },
      }),
    ]);
    expect(http.posted).toEqual([]);
    expect(composed.map((grounding) => grounding.language)).toEqual(['zh']);
    const queued = await db.database
      .select({ id: schema.proactiveCandidates.id })
      .from(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, seeded.familyId));
    expect(queued).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { createQueueWithPolicy } from '@hale/tools-contracts';
import { and, eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetPosthogClientsForTests } from '~/lib/analytics/posthog-node';
import { UNANSWERED_ROUTE, sweepUnansweredMessages } from '~/lib/analytics/unanswered';
import {
  CHANNEL_MESSAGE_RECEIVED_DLQ,
  CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_MESSAGE_RECEIVED_RETRY,
} from '~/lib/channel/config';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { resolveNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import {
  type DrainDeps,
  type DrainHandlers,
  drainBossFrom,
  drainHotQueues,
} from '~/lib/cron/drain';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { aggregateOpsDaily } from '~/lib/monitoring/ops-daily';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { createInboundBurst } from './burst';
import type { BurstReaderInput, InboundBurstReader } from './burst-reader';
import type { ChannelTurn } from './coach-runtime';
import { createDisambiguationStore } from './disambiguation';
import { FakeReplyTransport } from './reply-route';
import { type ChannelRouterDeps, type RouterStatus, routeChannelMessage } from './route';
import { darkSideTurn } from './side-turn.fixture';
import { auditSmokeAlarmClaim, auditTurnLedger, loadInboundContext } from './wiring';

/**
 * Back-to-back texts through the PRODUCTION drain (VIL-679): the real pg-boss on pglite,
 * the real per-parent singleton key, the real claim loop, the real context read and turn
 * ledger, and the real burst planner. The coach and the reader are the only stand-ins —
 * what they would say is the evals' job (rule #8); what is pinned here is that one drain
 * run takes both jobs, the first folds the second, the parent gets exactly one reply, and
 * the second job stops at GATE 0 as `folded` rather than answering again.
 */

const PHONE = '+14165550142';
const CHAT = 'chat-burst-direct';
const QUEUE = CHANNEL_MESSAGE_RECEIVED_QUEUE;

let db: TestDb;
let boss: PgBoss;

async function bootPgBoss(): Promise<PgBoss> {
  const started = new PgBoss({
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    db: {
      async executeSql(text: string, values?: unknown[]) {
        if (values && values.length > 0) return await db.client.query(text, values);
        const results = await db.client.exec(text);
        return results.at(-1) ?? { rows: [] };
      },
    },
  } as never);
  await started.start();
  await createQueueWithPolicy(started, QUEUE, {
    expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
    retry: CHANNEL_MESSAGE_RECEIVED_RETRY,
    deadLetter: CHANNEL_MESSAGE_RECEIVED_DLQ,
  });
  return started;
}

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
  boss = await bootPgBoss();
}, 120_000);

afterAll(async () => {
  await boss.stop({ wait: false });
  await db.close();
  vi.unstubAllEnvs();
});

function foldAllReader(): InboundBurstReader & { calls: BurstReaderInput[] } {
  const reader = {
    calls: [] as BurstReaderInput[],
    async read(input: BurstReaderInput) {
      reader.calls.push(input);
      return { status: 'read' as const, groups: [input.messages.map((m) => m.ref)] };
    },
  };
  return reader;
}

function routerDeps(
  transport: FakeReplyTransport,
  reader: InboundBurstReader,
  options: {
    database?: Database;
    enabled?: () => boolean;
    loadContext?: ChannelRouterDeps['loadContext'];
    coached?: ChannelTurn[];
  } = {},
): ChannelRouterDeps {
  const now = () => new Date();
  const database = options.database ?? db.database;
  return {
    database,
    loadContext: options.loadContext ?? loadInboundContext,
    transport,
    handlers: [],
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    coach: {
      async respond(turn) {
        options.coached?.push(turn);
        return {
          reply: 'Looking within $900 for her.',
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
        };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(database),
    turns: auditTurnLedger(database),
    burst: createInboundBurst(database, {
      enabled: options.enabled ?? (() => true),
      reader,
      now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    }),
    sideTurn: darkSideTurn(),
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    floodLine: { compose: async () => ({ status: 'composed', line: 'busy' }) },
    recordPlanOffer: async () => ({ status: 'recorded' }),
    recordCapabilityNotes: async () => ({ status: 'recorded', declined: 0, corrected: 0 }),
    recordActivityPromise: async () => ({
      status: 'recorded',
      commitmentId: '77777777-7777-4777-8777-777777777777',
    }),
    questions: { open: async () => [] },
    replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
    calendarOffers: calendarOffersIdle,
    weekdayCareReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    disambiguation: createDisambiguationStore(),
    reconcileView: loadReconcileView,
    claimShadow: { coachTurn: () => 'off', sweep: () => 'off', dispatch: () => 'off' },
    claimEnforcer: {
      enforces: () => false,
      read: async () => {
        throw new Error('the claim reader is not enforced here');
      },
    },
    recordStatedState: async () => ({ status: 'nothing_stated' }),
    weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
    recordWeekdayCare: async (_db, input) => ({
      status: 'recorded' as const,
      care: input.care,
      providerNamed: input.provider !== null,
    }),
    searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'not_configured' }),
    recordRegistrationWatch: async () => ({ status: 'recorded' }),
    armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
    dispatchDeepResearch: async () => ({ status: 'enqueued' }),
    limiter: new FakeRateLimiter(() => Date.now()),
    now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function drainDeps(channelMessage: DrainHandlers['channelMessage']): DrainDeps {
  const inert = async () => undefined;
  return {
    boss: drainBossFrom(boss),
    handlers: {
      runOrchestrator: inert as unknown as DrainHandlers['runOrchestrator'],
      executeApprovedAction: inert as unknown as DrainHandlers['executeApprovedAction'],
      rerank: inert,
      channelSend: inert,
      channelSendDead: inert,
      channelMessage,
      foldedInto: async () => [],
      deepResearch: inert,
      autonomyNotices: inert,
    },
    log: { info: vi.fn(), error: vi.fn() },
    now: () => Date.now(),
    pageExpiredTurn: vi.fn(async () => undefined),
  };
}

describe('two texts on one parent key, one drain run', () => {
  it('folds the second into the first: one reply, under the second text', async () => {
    const fam = await seedFamily(db.database, 'Burst Drain');
    await db.database.insert(schema.parentChannels).values({
      familyId: fam.familyId,
      userId: fam.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date(),
    });
    // Arrived seconds ago, so the settle finds them quiet and does not wait.
    const arrived = Date.now() - 6_000;
    const jobs: ChannelMessageReceivedJob[] = [];
    for (const [offset, body, providerId] of [
      [0, '$600 budget for a fall program', 'prov-burst-1'],
      [700, '$900', 'prov-burst-2'],
    ] as const) {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId: fam.familyId,
          parentUserId: fam.parentUserId,
          channel: 'imessage',
          direction: 'in',
          category: 'reply',
          providerMessageId: providerId,
          providerChatId: CHAT,
          status: 'delivered',
          body,
          inGroup: false,
          createdAt: new Date(arrived + offset),
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('no inbound row');
      const job: ChannelMessageReceivedJob = {
        family_id: fam.familyId,
        parent_user_id: fam.parentUserId,
        channel_message_id: row.id,
        provider_message_id: providerId,
        received_at: new Date(arrived + offset).toISOString(),
        in_group: false,
      };
      jobs.push(job);
      const created = await boss.send(QUEUE, job, {
        id: row.id,
        singletonKey: channelSmsNoteKey(fam.parentUserId),
        expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
      });
      if (!created) throw new Error('pg-boss created no job');
      // pglite's clock ticks in ms: stamp the claim order explicitly.
      await db.client.query(
        "update pgboss.job set created_on = now() + $2::int * interval '1 millisecond', start_after = now() - interval '1 minute' where id = $1",
        [created, offset + 1],
      );
    }

    const transport = new FakeReplyTransport();
    const reader = foldAllReader();
    const deps = routerDeps(transport, reader);
    const outcomes: Array<{ id: string; status: RouterStatus }> = [];
    const summary = await drainHotQueues(
      drainDeps(async (job) => {
        const result = await routeChannelMessage(deps, job as ChannelMessageReceivedJob);
        outcomes.push({
          id: (job as ChannelMessageReceivedJob).channel_message_id,
          status: result.status,
        });
      }),
    );

    const [first, second] = jobs;
    expect(summary.processed).toBe(2);
    expect(outcomes).toEqual([
      { id: first?.channel_message_id, status: 'agent_replied' },
      { id: second?.channel_message_id, status: 'folded' },
    ]);
    expect(reader.calls).toHaveLength(1);
    expect(transport.bodies()).toEqual(['Looking within $900 for her.']);
    expect(transport.sent[0]?.route).toMatchObject({
      channel: 'imessage',
      chatId: CHAT,
      replyToMessageId: 'prov-burst-2',
    });
    const ledger = auditTurnLedger(db.database);
    expect(
      await ledger.stageOf({
        familyId: fam.familyId,
        channelMessageId: first?.channel_message_id ?? '',
      }),
    ).toBe('answered');
    expect(
      await ledger.stageOf({
        familyId: fam.familyId,
        channelMessageId: second?.channel_message_id ?? '',
      }),
    ).toBe('folded');
  });
});

async function seedDirectParent(database: Database, name: string, phone: string) {
  const fam = await seedFamily(database, name);
  await database.insert(schema.parentChannels).values({
    familyId: fam.familyId,
    userId: fam.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(),
  });
  return fam;
}

/** Inbound 1:1 rows that arrived seconds ago, so the settle finds them quiet. */
async function directTexts(
  database: Database,
  fam: { familyId: string; parentUserId: string },
  chatId: string,
  bodies: readonly string[],
): Promise<ChannelMessageReceivedJob[]> {
  const arrived = Date.now() - 6_000;
  const jobs: ChannelMessageReceivedJob[] = [];
  for (const [index, body] of bodies.entries()) {
    const at = new Date(arrived + index * 700);
    const providerId = `prov-${randomUUID()}`;
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: fam.familyId,
        parentUserId: fam.parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerMessageId: providerId,
        providerChatId: chatId,
        status: 'delivered',
        body,
        inGroup: false,
        createdAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('no inbound row');
    jobs.push({
      family_id: fam.familyId,
      parent_user_id: fam.parentUserId,
      channel_message_id: row.id,
      provider_message_id: providerId,
      received_at: at.toISOString(),
      in_group: false,
    });
  }
  return jobs;
}

async function answeredRows(database: Database, channelMessageId: string) {
  return database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'sms_turn_answered'),
        eq(schema.auditLog.targetTable, 'channel_messages'),
        eq(schema.auditLog.targetId, channelMessageId),
      ),
    );
}

describe('a turn that crashed after folding, retried with the flag off', () => {
  it('still answers the folded text inside the anchor’s turn, exactly once', async () => {
    const fam = await seedDirectParent(db.database, 'Crash Then Dark', '+14165550143');
    const [first, second] = await directTexts(db.database, fam, 'chat-burst-crash', [
      'swim thursday at 4',
      'sorry 5',
    ]);
    if (!first || !second) throw new Error('no jobs');
    let lit = true;
    let crashes = 1;
    const coached: ChannelTurn[] = [];
    const transport = new FakeReplyTransport();
    const deps = routerDeps(transport, foldAllReader(), {
      enabled: () => lit,
      coached,
      loadContext: async (database, job) => {
        if (crashes > 0) {
          crashes -= 1;
          throw new Error('the function died after the fold');
        }
        return loadInboundContext(database, job);
      },
    });

    await expect(routeChannelMessage(deps, first)).rejects.toThrow('died after the fold');
    expect(transport.sent).toEqual([]);
    lit = false;
    const retried = await routeChannelMessage(deps, first);
    const own = await routeChannelMessage(deps, second);

    expect(retried.status).toBe('agent_replied');
    expect(own.status).toBe('folded');
    expect(transport.bodies()).toEqual(['Looking within $900 for her.']);
    expect(coached.map((turn) => [turn.body, turn.burstSize])).toEqual([
      ['swim thursday at 4\nsorry 5', 2],
    ]);
    const conversationId = await resolveNoteConversation(
      fam.familyId,
      channelSmsNoteKey(fam.parentUserId),
      db.database,
    );
    if (!conversationId) throw new Error('no thread');
    const userRows = await db.database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.role, 'user')),
      );
    expect(userRows.map((row) => row.content)).toEqual(['swim thursday at 4', 'sorry 5']);
    expect(await answeredRows(db.database, first.channel_message_id)).toHaveLength(1);
    expect(await answeredRows(db.database, second.channel_message_id)).toHaveLength(1);
  });
});

describe('a folded text reads as answered to the unanswered sweep and the ops-daily post', () => {
  let own: TestDb;

  beforeAll(async () => {
    own = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await own.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetPosthogClientsForTests();
  });

  it('counts both texts of a burst answered, and still flags a text nobody answered', async () => {
    const fam = await seedDirectParent(own.database, 'Burst Answered', '+14165550144');
    const [first, second] = await directTexts(own.database, fam, 'chat-burst-sweep', [
      '$600 budget for a fall program',
      '$900',
    ]);
    if (!first || !second) throw new Error('no jobs');
    // Positive control: a text in another family that nothing answered.
    const quiet = await seedDirectParent(own.database, 'Never Answered', '+14165550145');
    const [unanswered] = await directTexts(own.database, quiet, 'chat-quiet', ['is swim on?']);
    if (!unanswered) throw new Error('no control');
    const transport = new FakeReplyTransport();
    const deps = routerDeps(transport, foldAllReader(), { database: own.database });

    expect((await routeChannelMessage(deps, first)).status).toBe('agent_replied');
    expect((await routeChannelMessage(deps, second)).status).toBe('folded');
    expect(transport.bodies()).toHaveLength(1);

    vi.stubEnv('POSTHOG_ERROR_TRACKING_ENABLED', 'true');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    resetPosthogClientsForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const sweep = await sweepUnansweredMessages(own.database, new Date(Date.now() + 60 * 60_000));
    const flagged = await own.database
      .select({ identifier: schema.rateLimits.identifier })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, UNANSWERED_ROUTE));
    expect(sweep.emitted).toBe(1);
    expect(flagged.map((row) => row.identifier)).toEqual([unanswered.channel_message_id]);

    const report = await aggregateOpsDaily(own.database, new Date(Date.now() + 2 * 60 * 60_000));
    expect(report.replies.inbound).toBe(3);
    expect(report.replies.answered).toBe(2);
    expect(report.replies.gaps).toBe(1);
  });
});

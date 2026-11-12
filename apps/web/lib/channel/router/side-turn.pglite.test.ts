import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { createQueueWithPolicy } from '@hale/tools-contracts';
import { and, asc, eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_MESSAGE_RECEIVED_DLQ,
  CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_MESSAGE_RECEIVED_RETRY,
} from '~/lib/channel/config';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { writeChannelMessage } from '~/lib/channel/intake/machine';
import type { OffDomainLane, OffDomainVerdict } from '~/lib/channel/off-domain/lane';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { resolveNoteConversation, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
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
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { BURST_QUIET_MS, createInboundBurst } from './burst';
import type { ChannelTurn } from './coach-runtime';
import { runTurn } from './deadline';
import { createDisambiguationStore } from './disambiguation';
import type { FloodLineComposer } from './flood-line';
import { FakeReplyTransport, type ReplyTransport } from './reply-route';
import { type ChannelRouterDeps, type RouterStatus, routeChannelMessage } from './route';
import {
  SIDE_TURN_TEMPLATE_KEY,
  type SideReply,
  type SideTurnOutcome,
  type SideTurnPorts,
  type SideTurnQueuedWhy,
  runSideTurn,
} from './side-turn';
import { darkSideTurn } from './side-turn.fixture';
import type { SideTurnFamily, SideTurnInput, SideTurnReading } from './side-turn-reader';
import { auditSmokeAlarmClaim, auditTurnLedger, loadInboundContext } from './wiring';

/**
 * A text that lands while the parent's turn is still running (VIL-679 phase 2).
 *
 * The real DDL, the real context read, the real turn ledger and answer claims, the real
 * router (its own send, receipts and GATE 0), and for the last case the real pg-boss
 * claim loop. The side read and the lanes are scripted: what they say is the eval's job
 * (run-inbound-side-turn-eval.mjs, rule #8). What is pinned here is what the side turn
 * does with what they say: a text ends answered or queued, never neither and never both.
 */

/** Each household its own synthetic 555 number: an active phone belongs to one parent. */
let phones = 100;
function nextPhone(): string {
  phones += 1;
  return `+1416555${String(phones).padStart(4, '0')}`;
}
const CHAT = 'chat-side-direct';
const QUEUE = CHANNEL_MESSAGE_RECEIVED_QUEUE;

let db: TestDb;
let boss: PgBoss;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
  boss = new PgBoss({
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
  await boss.start();
  await createQueueWithPolicy(boss, QUEUE, {
    expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
    retry: CHANNEL_MESSAGE_RECEIVED_RETRY,
    deadLetter: CHANNEL_MESSAGE_RECEIVED_DLQ,
  });
}, 120_000);

afterAll(async () => {
  await boss.stop({ wait: false });
  await db.close();
  vi.unstubAllEnvs();
});

interface Family {
  familyId: string;
  parentUserId: string;
}

interface Text {
  id: string;
  providerId: string;
  job: ChannelMessageReceivedJob;
}

async function seedParent(name: string): Promise<Family> {
  const fam = await seedFamily(db.database, name);
  const phone = nextPhone();
  await db.database.insert(schema.parentChannels).values({
    familyId: fam.familyId,
    userId: fam.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(),
  });
  return fam;
}

/** A 1:1 iMessage text the door handed to C1, `agoMs` old. */
async function text(
  fam: Family,
  body: string,
  agoMs: number,
  extra: Partial<typeof schema.channelMessages.$inferInsert> = {},
): Promise<Text> {
  const providerId = `prov-${randomUUID()}`;
  const at = new Date(Date.now() - agoMs);
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
      providerService: 'iMessage',
      status: 'delivered',
      body,
      inGroup: false,
      createdAt: at,
      ...extra,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no inbound row');
  return {
    id: row.id,
    providerId,
    job: {
      family_id: fam.familyId,
      parent_user_id: fam.parentUserId,
      channel_message_id: row.id,
      provider_message_id: providerId,
      received_at: at.toISOString(),
      in_group: false,
    },
  };
}

/** Quiet already: older than the burst's quiet window. */
const QUIET = BURST_QUIET_MS + 500;

const FAMILY: SideTurnFamily = {
  thread: [],
  children: [{ name: 'Ada', stage: 'school_age', ageMonths: 84 }],
  city: 'Toronto',
  memory: null,
  localNow: null,
};

function scriptedReader(
  answer: (input: SideTurnInput) => SideTurnReading | Promise<SideTurnReading>,
): SideTurnPorts['reader'] & { calls: SideTurnInput[] } {
  const reader = {
    calls: [] as SideTurnInput[],
    async read(input: SideTurnInput) {
      reader.calls.push(input);
      return answer(input);
    },
  };
  return reader;
}

const IN_DOMAIN: OffDomainVerdict = { status: 'in_domain', fallback: null };

function scriptedLane(
  verdictFor: (text: string) => OffDomainVerdict = () => IN_DOMAIN,
): OffDomainLane & { texts: string[] } {
  const lane = {
    texts: [] as string[],
    async consider(input: { text: string }) {
      lane.texts.push(input.text);
      return verdictFor(input.text);
    },
  };
  return lane;
}

interface Logged {
  line: string;
  fields: Record<string, unknown>;
}

function routerDeps(
  transport: ReplyTransport,
  options: {
    sideTurn?: Partial<SideTurnPorts>;
    offDomain?: OffDomainLane;
    limiter?: RateLimiter;
    floodLine?: FloodLineComposer;
    loadContext?: ChannelRouterDeps['loadContext'];
    coach?: (turn: ChannelTurn) => Promise<string>;
    logged?: Logged[];
  } = {},
): ChannelRouterDeps {
  const database = db.database;
  const record =
    (sink: Logged[] | undefined) =>
    (fields: unknown, line?: unknown): void => {
      sink?.push({ line: String(line), fields: (fields ?? {}) as Record<string, unknown> });
    };
  const log = {
    info: record(options.logged),
    warn: record(options.logged),
    error: record(options.logged),
  };
  return {
    database,
    loadContext: options.loadContext ?? loadInboundContext,
    transport,
    handlers: [],
    offDomain: options.offDomain ?? scriptedLane(),
    coach: {
      async respond(turn) {
        return {
          reply: options.coach ? await options.coach(turn) : 'Two Saturday art classes for her.',
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
        };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(database),
    turns: auditTurnLedger(database),
    burst: createInboundBurst(database, {
      enabled: () => false,
      reader: { read: async () => ({ status: 'unavailable', reason: 'client_unavailable' }) },
      now: () => new Date(),
      sleep: async () => undefined,
      log,
    }),
    sideTurn: {
      enabled: () => true,
      reader: scriptedReader(() => ({ status: 'read', verdict: 'hand_back' })),
      family: async () => FAMILY,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      ...options.sideTurn,
    },
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    floodLine: options.floodLine ?? {
      compose: async () => ({ status: 'composed', line: 'A lot at once, give me an hour.' }),
    },
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
    limiter: options.limiter ?? new FakeRateLimiter(() => Date.now()),
    now: () => new Date(),
    log,
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const settledLines = (logged: Logged[]) =>
  logged.filter((entry) => entry.line === 'side turn: settled');

async function threadRows(fam: Family): Promise<Array<{ role: string; content: string }>> {
  const conversationId = await resolveNoteConversation(
    fam.familyId,
    channelSmsNoteKey(fam.parentUserId),
    db.database,
  );
  if (!conversationId) return [];
  return db.database
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));
}

async function stageOf(fam: Family, id: string) {
  return auditTurnLedger(db.database).stageOf({ familyId: fam.familyId, channelMessageId: id });
}

describe('a quick question while the turn in front of it runs', () => {
  it('is answered beside it, threaded under its own text, and its own job then stops at GATE 0', async () => {
    const fam = await seedParent('Side Answered');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const transport = new FakeReplyTransport();
    const logged: Logged[] = [];
    const lane = scriptedLane();
    const reader = scriptedReader(() => ({
      status: 'read',
      verdict: 'answer',
      reply: 'Swim is Thursday at 4:30.',
    }));
    let quick: Text | undefined;
    const deps = routerDeps(transport, {
      logged,
      offDomain: lane,
      sideTurn: { reader },
      coach: async () => {
        // The parent texts again while this turn is thinking.
        quick = await text(fam, 'what time is swim on thursday?', QUIET);
        await waitFor(() => settledLines(logged).length === 1, 'the side turn');
        return 'Two Saturday art classes for her.';
      },
    });

    const result = await routeChannelMessage(deps, running.job);

    expect(result.status).toBe('agent_replied');
    expect(settledLines(logged).map((entry) => entry.fields)).toEqual([
      {
        runningId: running.id,
        channelMessageId: quick?.id,
        outcome: 'answered',
        by: 'side_read',
      },
    ]);
    expect(transport.sent.map((s) => [s.body, s.route])).toEqual([
      [
        'Swim is Thursday at 4:30.',
        expect.objectContaining({ chatId: CHAT, replyToMessageId: quick?.providerId }),
      ],
      [
        'Two Saturday art classes for her.',
        expect.objectContaining({ chatId: CHAT, replyToMessageId: running.providerId }),
      ],
    ]);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]).toMatchObject({
      text: 'what time is swim on thursday?',
      workingOn: ['can you find a saturday art class for Ada'],
      waitingOn: [],
    });
    // The crisis and off-domain lane read the new text too.
    expect(lane.texts).toContain('what time is swim on thursday?');
    expect(await stageOf(fam, quick?.id ?? '')).toBe('answered');
    expect(await threadRows(fam)).toEqual([
      { role: 'user', content: 'can you find a saturday art class for Ada' },
      { role: 'user', content: 'what time is swim on thursday?' },
      { role: 'assistant', content: 'Swim is Thursday at 4:30.' },
      { role: 'assistant', content: 'Two Saturday art classes for her.' },
    ]);
    const [sideRow] = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, fam.familyId),
          eq(schema.channelMessages.templateKey, SIDE_TURN_TEMPLATE_KEY),
        ),
      );
    expect(sideRow).toBeDefined();
    const receipts = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, sideRow?.id ?? ''));
    expect(receipts.map((row) => row.action)).toEqual(['sms_reply_sent']);

    // Its own job comes next under the parent's key, and says nothing.
    const own = await routeChannelMessage(deps, quick?.job as ChannelMessageReceivedJob);
    expect(own.status).toBe('already_answered');
    expect(transport.sent).toHaveLength(2);
  });

  it('hands back what belongs to its own turn: nothing sent, nothing threaded, answered after', async () => {
    const fam = await seedParent('Side Handed Back');
    const running = await text(fam, 'find a swim class for Milo on sunday', 20_000);
    const transport = new FakeReplyTransport();
    const logged: Logged[] = [];
    const reader = scriptedReader(() => ({ status: 'read', verdict: 'hand_back' }));
    let correction: Text | undefined;
    const coached: string[] = [];
    const deps = routerDeps(transport, {
      logged,
      sideTurn: { reader },
      coach: async (turn) => {
        coached.push(turn.body);
        if (!correction) {
          correction = await text(fam, 'actually make it saturday', QUIET);
          await waitFor(() => settledLines(logged).length === 1, 'the side turn');
          return 'Sunday swim for Milo: two options.';
        }
        return 'Saturday then: two options.';
      },
    });

    await routeChannelMessage(deps, running.job);

    expect(settledLines(logged)[0]?.fields).toMatchObject({
      outcome: 'queued',
      why: 'handed_back',
    });
    expect(transport.bodies()).toEqual(['Sunday swim for Milo: two options.']);
    expect(await stageOf(fam, correction?.id ?? '')).toBe('fresh');
    expect((await threadRows(fam)).map((row) => row.content)).not.toContain(
      'actually make it saturday',
    );

    // Queued behind the running turn, it is answered by its own turn, exactly as today.
    const own = await routeChannelMessage(deps, correction?.job as ChannelMessageReceivedJob);
    expect(own.status).toBe('agent_replied');
    expect(coached).toEqual(['find a swim class for Milo on sunday', 'actually make it saturday']);
    expect(transport.sent.at(-1)?.route).toMatchObject({
      replyToMessageId: correction?.providerId,
    });
    expect(
      (await threadRows(fam)).filter((row) => row.content === 'actually make it saturday'),
    ).toHaveLength(1);
  });

  it('dark: nothing is read, slept or sent, and the text waits its turn as today', async () => {
    const fam = await seedParent('Side Dark');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const transport = new FakeReplyTransport();
    const dark = darkSideTurn();
    let quick: Text | undefined;
    const deps = {
      ...routerDeps(transport, {
        coach: async () => {
          quick = await text(fam, 'what time is swim on thursday?', QUIET);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'Two Saturday art classes for her.';
        },
      }),
      sideTurn: dark,
    };

    await routeChannelMessage(deps, running.job);

    expect(dark.calls).toEqual([`enabled:${fam.familyId}`]);
    expect(transport.bodies()).toEqual(['Two Saturday art classes for her.']);
    expect(await stageOf(fam, quick?.id ?? '')).toBe('fresh');
  });

  it('two texts behind the turn are a burst for their own turn, never a side turn', async () => {
    const fam = await seedParent('Side Burst');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const transport = new FakeReplyTransport();
    const reader = scriptedReader(() => ({ status: 'read', verdict: 'answer', reply: 'x' }));
    const behind: Text[] = [];
    const deps = routerDeps(transport, {
      sideTurn: { reader },
      coach: async () => {
        behind.push(await text(fam, '$600 budget for a fall program', QUIET + 700));
        behind.push(await text(fam, '$900', QUIET));
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'Two Saturday art classes for her.';
      },
    });

    await routeChannelMessage(deps, running.job);

    expect(reader.calls).toEqual([]);
    expect(transport.bodies()).toEqual(['Two Saturday art classes for her.']);
    for (const queued of behind) expect(await stageOf(fam, queued.id)).toBe('fresh');
  });

  it('runs one side turn at a time, and the running job ends only once its side turn has', async () => {
    const fam = await seedParent('Side One At A Time');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const transport = new FakeReplyTransport();
    const logged: Logged[] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let most = 0;
    let second: Text | undefined;
    const reader = scriptedReader(async (input) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (input.text === 'how old is Ada now?') {
        // A second text lands while this side turn is still reading.
        second = await text(fam, 'is the library open sunday?', QUIET);
        await released;
      }
      inFlight -= 1;
      return { status: 'read', verdict: 'answer', reply: `re: ${input.text}` };
    });
    let ended = false;
    const deps = routerDeps(transport, {
      logged,
      sideTurn: { reader },
      coach: async () => {
        await text(fam, 'how old is Ada now?', QUIET);
        await waitFor(() => reader.calls.length === 1, 'the first side read');
        // The running turn answers while the side turn is still in flight.
        return 'Two Saturday art classes for her.';
      },
    });

    const turn = routeChannelMessage(deps, running.job).then((result) => {
      ended = true;
      return result;
    });
    await waitFor(() => transport.sent.length === 1, 'the running turn to answer');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    release();
    await turn;

    expect(most).toBe(1);
    expect(transport.bodies()).toEqual([
      'Two Saturday art classes for her.',
      're: how old is Ada now?',
    ]);
    // The second text arrived during the first side turn; the turn was over before it
    // could have one, so it waits for its own.
    expect(await stageOf(fam, second?.id ?? '')).toBe('fresh');
  });

  it('a STOP is the door’s, never a side turn’s: it is not a text C1 can read', async () => {
    const fam = await seedParent('Side Stop');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const transport = new FakeReplyTransport();
    const reader = scriptedReader(() => ({ status: 'read', verdict: 'answer', reply: 'x' }));
    const logged: Logged[] = [];
    let quick: Text | undefined;
    const deps = routerDeps(transport, {
      logged,
      sideTurn: { reader },
      coach: async () => {
        // The door reads every text for a stop BEFORE it is queued (inbound-route.ts),
        // and records one it acts on as the intake machine's row, not C1's.
        await writeChannelMessage(
          db.database,
          fam,
          {
            direction: 'in',
            body: 'stop',
            providerId: `prov-stop-${randomUUID()}`,
            channel: 'imessage',
            chatId: CHAT,
            inGroup: false,
            at: new Date(Date.now() - QUIET).toISOString(),
          },
          new Date(Date.now() - QUIET),
        );
        // Positive control: a text the door did hand to C1 is read.
        quick = await text(fam, 'what time is swim on thursday?', QUIET);
        await waitFor(() => settledLines(logged).length === 1, 'the side turn');
        return 'Two Saturday art classes for her.';
      },
    });

    await routeChannelMessage(deps, running.job);

    expect(reader.calls.map((call) => call.text)).toEqual(['what time is swim on thursday?']);
    expect(settledLines(logged)[0]?.fields).toMatchObject({ channelMessageId: quick?.id });
  });
});

/** Every way a side turn can end. A new reason is a compile error here until it has a case. */
type CaseKey =
  | SideTurnQueuedWhy
  | `answered:${Extract<SideTurnOutcome, { kind: 'answered' }>['by']}`;

interface Case {
  reading?: SideTurnReading | 'never';
  lane?: OffDomainVerdict;
  limiter?: RateLimiter;
  floodLine?: FloodLineComposer;
  context?: 'unknown' | 'not_a_parent' | 'unreachable' | 'media';
  service?: 'iMessage' | null;
  noThread?: true;
  abortDuringRead?: true;
  transportFails?: true;
}

const ANSWER: SideTurnReading = { status: 'read', verdict: 'answer', reply: 'Swim is at 4:30.' };
const SILENT: SideTurnReading = { status: 'read', verdict: 'answer', reply: '' };
const denied = (firstDenied: boolean): RateLimiter => ({
  check: async () => ({ allowed: false, retryAfterSec: 60, firstDenied }),
});

const CASES = {
  'answered:side_read': { reading: ANSWER },
  'answered:off_domain': {
    reading: SILENT,
    lane: {
      status: 'deflected',
      lane: 'off_domain_general',
      category: 'other',
      reply: 'The library opens at 10 on Sundays.',
      replySource: 'composed',
      medicalSource: null,
      signal: 'recorded',
      pendingAsk: null,
    },
  },
  'answered:flood_line': { reading: ANSWER, limiter: denied(true) },
  unknown_message: { context: 'unknown' },
  not_a_parent: { context: 'not_a_parent' },
  unreachable: { context: 'unreachable' },
  not_threaded: { service: null },
  has_media: { context: 'media' },
  no_thread: { noThread: true },
  handed_back: { reading: { status: 'read', verdict: 'hand_back' } },
  reader_unavailable: { reading: { status: 'unavailable', reason: 'model_failed' } },
  over_limit: { reading: ANSWER, limiter: denied(false) },
  moment_unwritten: {
    reading: ANSWER,
    lane: {
      status: 'unwritten',
      moment: 'emergency',
      reason: 'model_failed',
      lane: 'safety_critical',
      category: 'emergency',
    },
  },
  no_answer: { reading: SILENT },
  timeout: { reading: 'never' },
  turn_over: { reading: ANSWER, abortDuringRead: true },
  send_failed: { reading: ANSWER, transportFails: true },
} satisfies Record<CaseKey, Case>;

describe('every side turn ends answered or queued behind, never neither and never both', () => {
  it.each(Object.entries(CASES) as Array<[CaseKey, Case]>)('%s', async (key, setup) => {
    const fam = await seedParent(`Side Case ${key}`);
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const quick = await text(fam, 'what time is swim on thursday?', QUIET, {
      providerService: setup.service === null ? null : 'iMessage',
    });
    if (!setup.noThread) {
      await resolveOrCreateNoteConversation(
        fam.familyId,
        channelSmsNoteKey(fam.parentUserId),
        db.database,
      );
    }
    const transport = new FakeReplyTransport();
    const controller = new AbortController();
    const reader = scriptedReader(() => {
      if (setup.reading === 'never') return new Promise<SideTurnReading>(() => {});
      if (setup.abortDuringRead) controller.abort();
      return setup.reading ?? ANSWER;
    });
    const deps = routerDeps(transport, {
      sideTurn: { reader, budgetMs: 200 },
      offDomain: scriptedLane(() => setup.lane ?? IN_DOMAIN),
      ...(setup.limiter ? { limiter: setup.limiter } : {}),
      ...(setup.floodLine ? { floodLine: setup.floodLine } : {}),
      loadContext: async (database, job) => {
        const real = await loadInboundContext(database, job);
        if (!real) return null;
        if (setup.context === 'unknown') return null;
        if (setup.context === 'not_a_parent') return { ...real, role: null };
        if (setup.context === 'unreachable') return { ...real, reply: null };
        if (setup.context === 'media') {
          return {
            ...real,
            media: [{ kind: 'image', url: 'https://example.test/a.jpg', mime: 'image/jpeg' }],
          };
        }
        return real;
      },
    });
    const send = async (reply: SideReply): Promise<string> => {
      if (setup.transportFails) throw new Error('provider refused');
      await deps.transport.send({ route: reply.route, body: reply.body });
      await reply.claim();
      return 'out-row';
    };

    let pending: Promise<SideTurnOutcome> | undefined;
    await runTurn(controller.signal, () => {
      pending = runSideTurn(
        deps,
        {
          running: running.job,
          candidate: {
            channelMessageId: quick.id,
            providerMessageId: quick.providerId,
            body: 'what time is swim on thursday?',
            media: [],
            createdAt: new Date(quick.job.received_at),
          },
          workingOn: ['can you find a saturday art class for Ada'],
        },
        send,
      );
      return pending;
    }).catch(() => undefined);
    const outcome = await (pending as Promise<SideTurnOutcome>);

    const expected = key.startsWith('answered:')
      ? { kind: 'answered', by: key.slice('answered:'.length) }
      : { kind: 'queued', why: key };
    expect(outcome).toEqual(expected);

    const threaded = (await threadRows(fam)).filter(
      (row) => row.content === 'what time is swim on thursday?',
    );
    const claims = await db.database
      .select({ id: schema.channelTurnAnswerClaims.id })
      .from(schema.channelTurnAnswerClaims)
      .where(eq(schema.channelTurnAnswerClaims.channelMessageId, quick.id));
    if (outcome.kind === 'answered') {
      // Answered: one reply, under its own text, and claimed so its own job stops.
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.route).toMatchObject({ replyToMessageId: quick.providerId });
      expect(claims).toHaveLength(1);
      expect(threaded).toHaveLength(1);
      expect(await stageOf(fam, quick.id)).toBe('answered');
    } else if (outcome.why === 'send_failed') {
      // Threaded and counted, unsent: deferred, so its own turn answers it without
      // threading or counting it twice.
      expect(transport.sent).toEqual([]);
      expect(claims).toEqual([]);
      expect(threaded).toHaveLength(1);
      expect(await stageOf(fam, quick.id)).toBe('deferred');
    } else {
      // Queued: untouched, and its own job answers it after the running turn.
      expect(transport.sent).toEqual([]);
      expect(claims).toEqual([]);
      expect(threaded).toEqual([]);
      expect(await stageOf(fam, quick.id)).toBe('fresh');
    }
  });
});

describe('the side reply is finished as every coach reply is', () => {
  it("never carries a teenager's name (rule #1); a younger child's stays", async () => {
    const fam = await seedParent('Side Teen');
    await seedChild(db.database, fam.familyId, 'Zoe', 15 * 12);
    await seedChild(db.database, fam.familyId, 'Ada', 7 * 12);
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    const quick = await text(fam, 'when are practices this week?', QUIET);
    await resolveOrCreateNoteConversation(
      fam.familyId,
      channelSmsNoteKey(fam.parentUserId),
      db.database,
    );
    const transport = new FakeReplyTransport();
    const deps = routerDeps(transport, {
      sideTurn: {
        reader: scriptedReader(() => ({
          status: 'read',
          verdict: 'answer',
          reply: "Zoe's practice is at 6 and **Ada's** swim is at 4:30.",
        })),
      },
    });

    const outcome = await runSideTurn(
      deps,
      {
        running: running.job,
        candidate: {
          channelMessageId: quick.id,
          providerMessageId: quick.providerId,
          body: 'when are practices this week?',
          media: [],
          createdAt: new Date(quick.job.received_at),
        },
        workingOn: ['can you find a saturday art class for Ada'],
      },
      async (reply) => {
        await deps.transport.send({ route: reply.route, body: reply.body });
        await reply.claim();
        return 'out-row';
      },
    );

    expect(outcome).toEqual({ kind: 'answered', by: 'side_read' });
    const [sent] = transport.bodies();
    expect(sent).not.toContain('Zoe');
    expect(sent).not.toContain('**');
    expect(sent).toContain("Ada's swim is at 4:30.");
  });
});

describe('through the production drain', () => {
  it('one run takes both jobs: the quick one is answered beside the first, then stops at GATE 0', async () => {
    const fam = await seedParent('Side Drain');
    const running = await text(fam, 'can you find a saturday art class for Ada', 20_000);
    await boss.send(QUEUE, running.job, {
      id: running.id,
      singletonKey: channelSmsNoteKey(fam.parentUserId),
      expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
    });
    await db.client.query(
      "update pgboss.job set start_after = now() - interval '1 minute' where id = $1",
      [running.id],
    );
    const transport = new FakeReplyTransport();
    const logged: Logged[] = [];
    let quick: Text | undefined;
    const deps = routerDeps(transport, {
      logged,
      sideTurn: {
        reader: scriptedReader(() => ({
          status: 'read',
          verdict: 'answer',
          reply: 'Swim is Thursday at 4:30.',
        })),
      },
      coach: async () => {
        if (quick) return 'unexpected';
        // The webhook queues the second text on the same parent key mid-turn.
        quick = await text(fam, 'what time is swim on thursday?', QUIET);
        await boss.send(QUEUE, quick.job, {
          id: quick.id,
          singletonKey: channelSmsNoteKey(fam.parentUserId),
          expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
        });
        await db.client.query(
          "update pgboss.job set start_after = now() - interval '1 minute' where id = $1",
          [quick.id],
        );
        await waitFor(() => settledLines(logged).length === 1, 'the side turn');
        return 'Two Saturday art classes for her.';
      },
    });
    const outcomes: Array<{ id: string; status: RouterStatus }> = [];
    const inert = async () => undefined;
    const drain: DrainDeps = {
      boss: drainBossFrom(boss),
      handlers: {
        runOrchestrator: inert as unknown as DrainHandlers['runOrchestrator'],
        executeApprovedAction: inert as unknown as DrainHandlers['executeApprovedAction'],
        rerank: inert,
        channelSend: inert,
        channelSendDead: inert,
        channelMessage: async (job) => {
          const result = await routeChannelMessage(deps, job);
          outcomes.push({ id: job.channel_message_id, status: result.status });
        },
        foldedInto: async () => [],
        deepResearch: inert,
        autonomyNotices: inert,
      },
      log: { info: vi.fn(), error: vi.fn() },
      now: () => Date.now(),
      pageExpiredTurn: vi.fn(async () => undefined),
    };

    const summary = await drainHotQueues(drain, { queues: [QUEUE] });

    expect(summary.processed).toBe(2);
    expect(outcomes).toEqual([
      { id: running.id, status: 'agent_replied' },
      { id: quick?.id, status: 'already_answered' },
    ]);
    expect(transport.sent.map((s) => s.route)).toEqual([
      expect.objectContaining({ replyToMessageId: quick?.providerId }),
      expect.objectContaining({ replyToMessageId: running.providerId }),
    ]);
  });
});

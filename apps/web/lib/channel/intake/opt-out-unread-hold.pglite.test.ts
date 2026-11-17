import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type InboundRouteDeps,
  type InboundRouteOutcome,
  routeInboundText,
} from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import type { OptOutReading } from '~/lib/channel/intake/opt-out-reader';
import { resolveHeldText } from '~/lib/channel/intake/opt-out-recovery';
import { recoverHeldOptOutReads } from '~/lib/channel/intake/opt-out-recovery';
import type { OptOutRecoveryDeps } from '~/lib/channel/intake/opt-out-recovery';
import {
  OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV,
  OPT_OUT_UNREAD_HOLD_TURN_ENV,
} from '~/lib/channel/intake/opt-out-turn-flags';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { selectUnhandedInbound } from '~/lib/channel/reconcile/unhanded';
import { HANDOFF_GRACE_MS } from '~/lib/channel/reconcile/unhanded';
import { threadIfParent } from '~/lib/channel/thread';
import type { CrisisPager, SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { createTestDb, seedFamily } from '~/lib/testing/pglite';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+15555550190';
const NOW = new Date('2026-11-17T15:00:00.000Z');
const WEBHOOK = 'https://hooks.slack.test/ops';

function stubWebhook(): string[] {
  const posted: string[] = [];
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text as string);
    return new Response('ok', { status: 200 });
  });
  return posted;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function parentDb() {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const db = await createTestDb();
  const family = await seedFamily(db.database, 'Opt Out Family');
  await db.database.insert(schema.parentChannels).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
  });
  return { db, family };
}

function routeDeps(
  database: Awaited<ReturnType<typeof createTestDb>>['database'],
  reading: () => OptOutReading | null,
  holdThrows = false,
): {
  deps: InboundRouteDeps;
  jobs: unknown[];
  transport: FakeTransport;
  counted: InboundRouteOutcome[];
} {
  const transport = new FakeTransport();
  const jobs: unknown[] = [];
  const counted: InboundRouteOutcome[] = [];
  const intake: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    optOutReader: { read: async () => reading() },
    ...(holdThrows
      ? {
          optOutHold: {
            hold: async () => {
              throw new Error('hold store down');
            },
            settled: async () => {},
          },
        }
      : {}),
    now: NOW,
  };
  const deps: InboundRouteDeps = {
    database,
    intake: () => intake,
    enqueue: async (job) => {
      jobs.push(job);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async (outcome) => {
      counted.push(outcome);
    },
    now: () => NOW,
  };
  return { deps, jobs, transport, counted };
}

const NONE: OptOutReading = { intent: 'none', confirmation: '', language: 'en' };

describe('VIL-707 unread opt-out does not reach the coach', () => {
  it('a null opt-out read sends nothing and stays readable by the recovery sweep', async () => {
    vi.stubEnv(OPT_OUT_UNREAD_HOLD_TURN_ENV, 'true');
    const { db } = await parentDb();
    let read: OptOutReading | null = null;
    const route = routeDeps(db.database, () => read);
    const inbound = route.transport.inbound(PHONE, 'please stop texting me', {
      providerId: 'pm-unread',
      receivedAt: NOW,
    });

    expect(await routeInboundText(route.deps, inbound)).toBe('opt_out_held');

    expect(route.jobs).toEqual([]);
    expect(route.transport.bodies()).toEqual([]);
    const [row] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerMessageId, 'pm-unread'));
    expect(row).toMatchObject({
      category: 'intake',
      optOutUnread: true,
      handedOffAt: null,
      direction: 'in',
    });
    const [hold] = await db.database.select().from(schema.optOutHeldMessages);
    expect(hold?.providerMessageId).toBe('pm-unread');
    const held = hold ? await resolveHeldText(db.database, hold) : null;
    expect(held?.inbound.body).toBe('please stop texting me');

    read = NONE;
    const retry = route.transport.inbound(PHONE, 'please stop texting me', {
      providerId: 'pm-unread',
      receivedAt: NOW,
    });
    expect(await routeInboundText(route.deps, retry)).toBe('handed_off');
    expect(route.jobs).toHaveLength(1);
    expect(route.transport.bodies()).toEqual([]);
    const [after] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerMessageId, 'pm-unread'));
    expect(after).toMatchObject({ category: 'reply', optOutUnread: false });
    expect(after?.handedOffAt).toEqual(NOW);
  }, 30_000);

  it('true with a trailing newline still hands the unread text to the coach', async () => {
    vi.stubEnv(OPT_OUT_UNREAD_HOLD_TURN_ENV, 'true\n');
    const { db } = await parentDb();
    const route = routeDeps(db.database, () => null);
    const inbound = route.transport.inbound(PHONE, 'hello there', {
      providerId: 'pm-trim',
      receivedAt: NOW,
    });

    expect(await routeInboundText(route.deps, inbound)).toBe('handed_off');
    expect(route.jobs).toHaveLength(1);
  }, 30_000);

  it('a hold-write throw sends nothing, pages once, and leaves the message retryable', async () => {
    vi.stubEnv(OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV, 'true');
    const posted = stubWebhook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = await parentDb();
    let throwHold = true;
    let read: OptOutReading | null = null;
    const transport = new FakeTransport();
    const jobs: unknown[] = [];
    const intake: IntakeDeps = {
      transport,
      threadMessage: async () => 'conv-1',
      openQuestions: fakeNoOpenQuestions,
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => NOW.getTime()),
      optOutReader: { read: async () => read },
      optOutHold: {
        hold: async () => {
          if (throwHold) throw new Error('hold store down');
        },
        settled: async () => {},
      },
      now: NOW,
    };
    const deps: InboundRouteDeps = {
      database: db.database,
      intake: () => intake,
      enqueue: async (job) => {
        jobs.push(job);
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => NOW,
    };
    const inbound = transport.inbound(PHONE, 'a sentence the reader could not read', {
      providerId: 'pm-hold',
      receivedAt: NOW,
    });

    expect(await routeInboundText(deps, inbound)).toBe('opt_out_held');
    expect(jobs).toEqual([]);
    expect(transport.bodies()).toEqual([]);
    expect(await db.database.select().from(schema.channelMessages)).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('opt_out_hold_unwritten');

    throwHold = false;
    read = NONE;
    expect(await routeInboundText(deps, inbound)).toBe('handed_off');
    expect(jobs).toHaveLength(1);
    expect(transport.bodies()).toEqual([]);
  }, 30_000);

  it('an ordinary recovery read becomes a reply the reconciler can hand to the coach', async () => {
    vi.stubEnv(OPT_OUT_UNREAD_HOLD_TURN_ENV, 'true');
    const { db } = await parentDb();
    const route = routeDeps(db.database, () => null);
    const inbound = route.transport.inbound(PHONE, 'what is on saturday', {
      providerId: 'pm-ordinary',
      receivedAt: NOW,
    });
    expect(await routeInboundText(route.deps, inbound)).toBe('opt_out_held');

    const saidLine: SaidLineWriter = {
      write: async () => {
        throw new Error('not a crisis');
      },
    };
    const crisisPager: CrisisPager = {
      record: async () => {
        throw new Error('not a crisis');
      },
      page: async () => {
        throw new Error('not a crisis');
      },
    };
    const recovery: OptOutRecoveryDeps = {
      reader: { read: async () => NONE },
      transport: new FakeTransport(),
      saidLine,
      crisisPager,
      threadMessage: threadIfParent,
      preflight: async () => ({ proceed: true, health: null }),
      now: NOW,
    };
    const result = await recoverHeldOptOutReads(db.database, recovery);
    expect(result.outcomes.read_not_stop).toBe(1);

    const [row] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerMessageId, 'pm-ordinary'));
    expect(row).toMatchObject({ category: 'reply', optOutUnread: false, handedOffAt: null });
    const owed = await selectUnhandedInbound(
      db.database,
      new Date((row?.createdAt ?? NOW).getTime() + HANDOFF_GRACE_MS + 1_000),
    );
    expect(owed.map((item) => item.providerMessageId)).toContain('pm-ordinary');
    expect(route.jobs).toEqual([]);
    expect(route.transport.bodies()).toEqual([]);
  }, 30_000);

  it('a stop read late stays out of the coach queue', async () => {
    vi.stubEnv(OPT_OUT_UNREAD_HOLD_TURN_ENV, 'true');
    const { db } = await parentDb();
    const route = routeDeps(db.database, () => null);
    const inbound = route.transport.inbound(PHONE, 'please stop texting me now', {
      providerId: 'pm-stop-late',
      receivedAt: NOW,
    });
    expect(await routeInboundText(route.deps, inbound)).toBe('opt_out_held');

    const saidLine: SaidLineWriter = {
      write: async () => {
        throw new Error('not a crisis');
      },
    };
    const crisisPager: CrisisPager = {
      record: async () => {
        throw new Error('not a crisis');
      },
      page: async () => {
        throw new Error('not a crisis');
      },
    };
    const recovery: OptOutRecoveryDeps = {
      reader: {
        read: async () => ({ intent: 'stop', confirmation: 'model wrote this', language: 'en' }),
      },
      transport: new FakeTransport(),
      saidLine,
      crisisPager,
      threadMessage: threadIfParent,
      preflight: async () => ({ proceed: true, health: null }),
      now: NOW,
    };
    const result = await recoverHeldOptOutReads(db.database, recovery);
    expect(result.outcomes.stopped_late_unconfirmed).toBe(1);
    const [row] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerMessageId, 'pm-stop-late'));
    expect(row?.category).toBe('intake');
    const owed = await selectUnhandedInbound(
      db.database,
      new Date((row?.createdAt ?? NOW).getTime() + HANDOFF_GRACE_MS + 1_000),
    );
    expect(owed.map((item) => item.providerMessageId)).not.toContain('pm-stop-late');
  }, 30_000);
});

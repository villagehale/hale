import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { createLinqPhoneTransport } from '~/lib/channel/linq/transport';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createInboundBurst } from '~/lib/channel/router/burst';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { createReplyTransport } from '~/lib/channel/router/reply-transport';
import { type ChannelRouterDeps, routeChannelMessage } from '~/lib/channel/router/route';
import { darkSideTurn } from '~/lib/channel/router/side-turn.fixture';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { AckEtaRouterPorts } from './arm';
import { ackPromiseFor, recordAckPromise } from './promise';

/**
 * VIL-717 · the queue is at-least-once, so one text can run twice. The real router, DDL,
 * turn ledger, promise ledger and Linq door, with only `fetch` stubbed: a stand-in Linq
 * that drops a repeated idempotency key the way the real one does. The read and the writer
 * are stand-ins because what the model says is the cached eval's job (rule #8).
 */

const PHONE = '+15550000123';
const ACK = 'the ack, from facts';
const ANSWER = 'the real answer';

let db: TestDb;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

/** Linq's side of the wire: one bubble per idempotency key. */
function stubLinq() {
  const bubbles: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  let id = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        message?: { idempotency_key?: string; parts?: Array<{ value?: string }> };
      };
      const key = body.message?.idempotency_key;
      const text = body.message?.parts?.[0]?.value;
      if (text !== undefined) {
        if (key) keys.push(key);
        if (!key || !seen.has(key)) bubbles.push(text);
        if (key) seen.add(key);
      }
      id += 1;
      return new Response(
        JSON.stringify({ chat: { id: 'chat-sms', message: { id: `linq-${id}` } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return { bubbles, keys };
}

async function seedText() {
  const fam = await seedFamily(db.database, 'Redelivery');
  await db.database.insert(schema.parentChannels).values({
    familyId: fam.familyId,
    userId: fam.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: new Date(),
  });
  const arrived = new Date(Date.now() - 6_000);
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'prov-redelivery',
      status: 'delivered',
      body: 'an invented slow ask',
      inGroup: false,
      createdAt: arrived,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seed: channel_messages insert returned no row');
  const job: ChannelMessageReceivedJob = {
    family_id: fam.familyId,
    parent_user_id: fam.parentUserId,
    channel_message_id: row.id,
    provider_message_id: 'prov-redelivery',
    received_at: arrived.toISOString(),
    in_group: false,
  };
  return { job, inboundId: row.id };
}

function ackPorts(
  record: AckEtaRouterPorts['record'],
): AckEtaRouterPorts & { writes: () => number } {
  let writes = 0;
  return {
    writes: () => writes,
    reader: { read: async () => ({ status: 'read', task: 'find' }) },
    writer: {
      ack: async () => {
        writes += 1;
        return { status: 'composed', line: ACK };
      },
      lateNote: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
    },
    record,
    promiseFor: ackPromiseFor,
    page: async () => 'paged',
  };
}

/** The first attempt fails once the ack had its chance; the second answers. */
function failingOnceCoach(): ChannelRouterDeps['coach'] {
  let attempts = 0;
  return {
    async respond() {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (attempts === 1) throw new Error('the coach failed');
      return { reply: ANSWER, planOffer: null, activityPromise: null, spotWatch: null };
    },
  };
}

function routerDeps(ackEta: AckEtaRouterPorts): ChannelRouterDeps {
  const database = db.database;
  const now = () => new Date();
  return {
    database,
    loadContext: loadInboundContext,
    transport: createReplyTransport({ phone: createLinqPhoneTransport() }),
    handlers: [],
    offDomain: {
      consider: async (input) => {
        input.onScreened?.({ lane: 'in_domain', category: null, fallback: null, language: null });
        return { status: 'in_domain', fallback: null };
      },
    },
    coach: failingOnceCoach(),
    smokeAlarm: auditSmokeAlarmClaim(database),
    turns: auditTurnLedger(database),
    burst: createInboundBurst(database, {
      enabled: () => false,
      reader: { read: async () => ({ status: 'unavailable', reason: 'model_failed' }) },
      now,
      sleep: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    }),
    sideTurn: darkSideTurn(),
    // The function dies in the failure path, before any ledger row: the next delivery is fresh.
    apology: {
      compose: async () => {
        throw new Error('the function died');
      },
    },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    holdingTapback: { compose: async () => ({ status: 'composed', reaction: { type: 'like' } }) },
    ackEta,
    holdingLineAfterMs: 5,
    sendParentReaction: async () => ({ status: 'sent' }),
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
    schoolBreakReplyReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    recordSchoolBreak: async () => {},
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

async function deliverTwice(deps: ChannelRouterDeps, job: ChannelMessageReceivedJob) {
  await expect(routeChannelMessage(deps, job)).rejects.toThrow('the function died');
  await routeChannelMessage(deps, job);
}

describe('VIL-717 · one inbound, delivered twice, one ack', () => {
  beforeEach(() => {
    vi.stubEnv('ACK_ETA_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'test-key-not-a-secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550199');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    await db.exec('truncate table families, users cascade');
  });

  it('a promise on record: the second delivery writes no ack and sends none', async () => {
    const linq = stubLinq();
    const { job, inboundId } = await seedText();
    const ports = ackPorts(recordAckPromise);

    await deliverTwice(routerDeps(ports), job);

    expect(linq.bubbles).toEqual([ACK, ANSWER]);
    expect(ports.writes()).toBe(1);
    const promises = await db.database
      .select({ id: schema.ackPromises.id })
      .from(schema.ackPromises)
      .where(eq(schema.ackPromises.inboundChannelMessageId, inboundId));
    expect(promises).toHaveLength(1);
  });

  it('a death between the send and the promise: Linq gets one key, the parent one ack', async () => {
    const linq = stubLinq();
    const { job } = await seedText();
    let records = 0;
    const ports = ackPorts(async (database, input) => {
      records += 1;
      if (records === 1) return { status: 'not_recorded', reason: 'write_failed' };
      return recordAckPromise(database, input);
    });

    await deliverTwice(routerDeps(ports), job);

    expect(ports.writes()).toBe(2);
    expect(linq.bubbles).toEqual([ACK, ANSWER]);
    // The answer carries no caller key; both of the ack's attempts carry the same one.
    expect(linq.keys).toHaveLength(2);
    expect(linq.keys[0]).toBe(linq.keys[1]);
  });
});

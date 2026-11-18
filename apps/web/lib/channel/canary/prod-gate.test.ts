import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyLinqWebhookSignature } from '~/lib/channel/linq/signature';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { CANARY_BODY, CANARY_PHONE_E164 } from './config';
import { inboundCanaryHandler } from './handler';
import { type ProdTextGateDeps, readProdGateTurn, runProdTextGate } from './prod-gate';
import { seedCanaryHousehold } from './seed';

/**
 * The promotion gate, over the real tables and a fake door.
 *
 * A pass is this deployment's audit stamp. A door that refuses, a turn that
 * lands and is never answered, and an answer written without this deployment's
 * id all come back not-ok. The last one is the previous build's cron winning
 * the job: one retry, then hold. Nothing here texts a parent or calls a model.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const LINQ_KEY_BYTES = Buffer.alloc(32, 9);
const LINQ_SECRET = `whsec_${LINQ_KEY_BYTES.toString('base64')}`;
const ORIGIN = 'https://hale-web-candidate.vercel.app';
const DEPLOYMENT_ID = 'dpl_candidate';
const NOW = new Date('2026-11-17T12:00:00.000Z');

let db: TestDb;

const FAST: ProdTextGateDeps['timing'] = {
  attempts: 2,
  injectionTimeoutMs: 1_000,
  drainTimeoutMs: 1_000,
  pollIntervalMs: 0,
  pollBudgetMs: 0,
};

function productionEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    VERCEL_ENV: 'production',
    VERCEL_URL: 'hale-web-candidate.vercel.app',
    APP_URL: 'https://app.villagehale.com',
    CRON_SECRET: 'cron-test',
    LINQ_WEBHOOK_SECRET: LINQ_SECRET,
    LINQ_API_KEY: 'linq-test-key',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-test',
    ...overrides,
  };
}

function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  await seedCanaryHousehold(db.database);
}, 120_000);

afterAll(async () => {
  process.env.APP_ENCRYPTION_KEY = '';
  await db.close();
});

beforeEach(async () => {
  await db.database.delete(schema.auditLog);
  await db.database.delete(schema.channelMessages);
  process.env.LINQ_WEBHOOK_SECRET = LINQ_SECRET;
  process.env.LINQ_API_KEY = 'linq-test-key';
  process.env.VERCEL_DEPLOYMENT_ID = DEPLOYMENT_ID;
});

async function insertInbound(
  database: Database,
  providerMessageId: string,
  handedOff: boolean,
): Promise<string> {
  const [household] = await database
    .select({
      familyId: schema.parentChannels.familyId,
      userId: schema.parentChannels.userId,
    })
    .from(schema.parentChannels)
    .limit(1);
  if (!household) throw new Error('canary household missing');
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: household.familyId,
      parentUserId: household.userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId,
      status: 'delivered',
      body: CANARY_BODY,
      sentAt: NOW,
      handedOffAt: handedOff ? NOW : null,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

interface InboundPayload {
  data: {
    id: string;
    sender_handle: { handle: string };
    chat: { id: string };
    parts: { value: string }[];
  };
}

async function answerAsThisDeployment(messageId: string): Promise<void> {
  const [household] = await db.database
    .select({
      familyId: schema.parentChannels.familyId,
      userId: schema.parentChannels.userId,
    })
    .from(schema.parentChannels)
    .limit(1);
  if (!household) throw new Error('canary household missing');
  await inboundCanaryHandler().handle(db.database, {
    familyId: household.familyId,
    parentUserId: household.userId,
    conversationId: '66666666-6666-4666-8666-666666666666',
    body: CANARY_BODY,
    now: NOW,
    send: async () => {
      throw new Error('the gate must not send');
    },
    resolved: null,
    openQuestions: async () => [],
    inboundChannelMessageId: messageId,
  });
}

async function answerAsPreviousBuild(messageId: string): Promise<void> {
  const [message] = await db.database
    .select({ id: schema.channelMessages.id, familyId: schema.channelMessages.familyId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, messageId))
    .limit(1);
  const [household] = await db.database
    .select({ userId: schema.parentChannels.userId })
    .from(schema.parentChannels)
    .limit(1);
  if (!message || !household) throw new Error('turn missing');
  await db.database.insert(schema.auditLog).values({
    familyId: message.familyId,
    actor: household.userId,
    actionTaken: 'sms_canary_answered',
    targetTable: 'channel_messages',
    targetId: message.id,
    after: { deploymentId: null },
  });
}

function door(options: {
  inboundStatus?: number;
  land?: boolean;
  enqueue?: boolean;
  answer?: 'this' | 'previous' | 'none';
}): { fetch: typeof globalThis.fetch; inbound: number; drain: number } {
  const counts = { inbound: 0, drain: 0 };
  let lastMessageId: string | null = null;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = hrefOf(input);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-vercel-protection-bypass')).toBe('bypass-test');
    if (href.includes('/api/channels/linq/inbound')) {
      counts.inbound += 1;
      const body = String(init?.body);
      expect(headers.get('authorization')).toBeNull();
      expect(
        verifyLinqWebhookSignature({
          secret: LINQ_SECRET,
          rawBody: body,
          webhookId: headers.get('webhook-id'),
          timestamp: headers.get('webhook-timestamp'),
          signature: headers.get('webhook-signature'),
          now: NOW,
        }),
      ).toBe(true);
      const payload = JSON.parse(body) as InboundPayload;
      expect(payload.data.id.startsWith('hale-prod-gate-')).toBe(true);
      expect(payload.data.sender_handle.handle).toBe(CANARY_PHONE_E164);
      expect(payload.data.chat.id.startsWith('canary-')).toBe(true);
      expect(payload.data.parts[0]?.value).toBe(CANARY_BODY);
      const status = options.inboundStatus ?? 200;
      if (status >= 200 && status < 300 && options.land !== false) {
        lastMessageId = await insertInbound(
          db.database,
          payload.data.id,
          options.enqueue !== false,
        );
      }
      return new Response('{}', { status });
    }
    if (href.includes('/api/cron/drain')) {
      counts.drain += 1;
      expect(href).toContain('queues=channel.message.received');
      expect(headers.get('authorization')).toBe('Bearer cron-test');
      if (lastMessageId && options.answer === 'this') await answerAsThisDeployment(lastMessageId);
      if (lastMessageId && options.answer === 'previous') {
        await answerAsPreviousBuild(lastMessageId);
      }
      return new Response('{}', { status: 202 });
    }
    throw new Error(`unexpected ${href}`);
  }) as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    get inbound() {
      return counts.inbound;
    },
    get drain() {
      return counts.drain;
    },
  };
}

function run(
  fetchImpl: typeof globalThis.fetch,
  env = productionEnv(),
): Promise<Awaited<ReturnType<typeof runProdTextGate>>> {
  return runProdTextGate({
    database: db.database,
    fetch: fetchImpl,
    now: () => NOW,
    origin: ORIGIN,
    deploymentId: DEPLOYMENT_ID,
    env,
    sleep: async () => {},
    timing: FAST,
  });
}

describe('runProdTextGate', () => {
  it('a turn this deployment answers is a pass, and it does not send', async () => {
    const fake = door({ answer: 'this' });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: true, stage: 'answered', attempts: 1 });
    expect(fake.inbound).toBe(1);
    expect(fake.drain).toBe(1);

    const [message] = await db.database.select().from(schema.channelMessages);
    if (!message) throw new Error('no inbound row');
    const evidence = await readProdGateTurn(db.database, message.providerMessageId ?? '');
    expect(evidence).toEqual({
      landed: true,
      enqueued: true,
      answered: true,
      deploymentId: DEPLOYMENT_ID,
    });
  });

  it('a door that refuses holds, and does not ask the drain', async () => {
    const fake = door({ inboundStatus: 500 });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'injection', attempts: 1 });
    expect(fake.drain).toBe(0);
  });

  it('a redirect is a refusal — following it would test the build still serving', async () => {
    const fake = door({ inboundStatus: 307, land: false });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'injection', attempts: 1 });
  });

  it('an accepted post that writes no row is not_landed', async () => {
    const fake = door({ land: false });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'not_landed', attempts: 1 });
  });

  it('a row the door did not hand off is not_enqueued', async () => {
    const fake = door({ enqueue: false, answer: 'none' });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'not_enqueued', attempts: 1 });
  });

  it('an enqueued turn with no answer is never_answered, once', async () => {
    const fake = door({ answer: 'none' });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'never_answered', attempts: 1 });
    expect(fake.inbound).toBe(1);
  });

  it('an answer from the previous build is retried once, then held', async () => {
    const fake = door({ answer: 'previous' });
    const result = await run(fake.fetch);
    expect(result).toEqual({ ok: false, stage: 'answered_elsewhere', attempts: 2 });
    expect(fake.inbound).toBe(2);
  });

  it('refuses to probe the parent domain', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await runProdTextGate({
      database: db.database,
      fetch: fetchImpl,
      now: () => NOW,
      origin: 'https://app.villagehale.com',
      deploymentId: DEPLOYMENT_ID,
      env: productionEnv(),
      sleep: async () => {},
      timing: FAST,
    });
    expect(result).toEqual({ ok: false, stage: 'not_configured', attempts: 0 });
    expect(called).toBe(false);
  });

  it('names a missing Linq secret instead of posting', async () => {
    Reflect.deleteProperty(process.env, 'LINQ_API_KEY');
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await run(fetchImpl, productionEnv({ LINQ_API_KEY: '' }));
    expect(result.stage).toBe('not_configured');
    expect(called).toBe(false);
  });

  it('holds when the probe channel is revoked', async () => {
    await db.database.update(schema.parentChannels).set({ revokedAt: NOW });
    try {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof globalThis.fetch;
      const result = await run(fetchImpl);
      expect(result).toEqual({ ok: false, stage: 'household', attempts: 0 });
      expect(called).toBe(false);
    } finally {
      await db.database.update(schema.parentChannels).set({ revokedAt: null });
    }
  });
});

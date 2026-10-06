import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeSpokenLineComposer } from '../voice/fakes';
import { handleLinqInboundRequest } from './inbound';
import type { ListChatHandles } from './roster';

/**
 * Group onboarding v2, §4: in the family group Hale answers when it is spoken to. A
 * parent talking to the other parent is recorded as an outcome and nothing else — no
 * ledger row, no coach turn, no budget — and the turns that do reach the coach spend the
 * chat's budget rather than the sender's.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const PARENT = '+14165550111';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const CHAT = 'chat-family-group';

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedClaimedHousehold(): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Parent', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:Parent', name: 'Parent' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  });
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Maya', dateOfBirth: '2021-05-02' });
  return { familyId, userId };
}

function signed(body: unknown): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET_BYTES).update(`evt_group.${TS}.${raw}`).digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_group',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function groupMessage(text: string, messageId: string) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_group',
    created_at: NOW.toISOString(),
    data: {
      chat: { id: CHAT, is_group: true },
      id: messageId,
      direction: 'inbound',
      sender_handle: { handle: PARENT, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
  };
}

function door() {
  const jobs: ChannelMessageReceivedJob[] = [];
  const outcomes: string[] = [];
  const sends: Array<{ chatId: string; text: string }> = [];
  const transport = new FakeTransport();
  const listHandles: ListChatHandles = async () => ({
    status: 'ok',
    handles: [PARENT],
    isGroup: true,
  });
  const intake: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new PostgresRateLimiter(db.database),
    now: NOW,
  };
  const deps = {
    database: db.database,
    intake: () => intake,
    enqueue: async (job: ChannelMessageReceivedJob) => {
      jobs.push(job);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async (outcome: string) => {
      outcomes.push(outcome);
    },
    now: () => NOW,
    groupVoice: fakeSpokenLineComposer(),
    listChatHandles: listHandles,
    groupLimiter: new PostgresRateLimiter(db.database),
    sendGroupText: async (input: { chatId: string; text: string }) => {
      sends.push(input);
      return { providerMessageId: `out-${sends.length}` };
    },
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  return { deps, jobs, outcomes, sends, transport };
}

async function budgetRows() {
  return db.database
    .select({ identifier: schema.rateLimits.identifier, route: schema.rateLimits.route })
    .from(schema.rateLimits);
}

async function inboundRows(familyId: string) {
  return db.database
    .select({ body: schema.channelMessages.body })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

describe('a message in the family group', () => {
  it('is chatter when it is not for Hale: no ledger row, no coach, no budget', async () => {
    const { familyId } = await seedClaimedHousehold();
    const { deps, jobs, outcomes, sends, transport } = door();

    const response = await handleLinqInboundRequest(
      signed(groupMessage('love you, see you tonight', 'in-chatter')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'group_chatter_ignored' });
    expect(outcomes).toEqual(['ignored']);
    expect(jobs).toEqual([]);
    expect(await inboundRows(familyId)).toEqual([]);
    expect(await budgetRows()).toEqual([]);
    expect(sends).toEqual([]);
    expect(transport.bodies()).toEqual([]);
  });

  it('goes to the coach when it names Hale, spending the chat budget and not the sender’s', async () => {
    const { familyId } = await seedClaimedHousehold();
    const { deps, jobs } = door();

    const response = await handleLinqInboundRequest(
      signed(groupMessage('Hale, is swim still on tomorrow', 'in-addressed')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    expect(jobs).toHaveLength(1);
    expect(await inboundRows(familyId)).toEqual([{ body: 'Hale, is swim still on tomorrow' }]);
    expect(await budgetRows()).toEqual([{ identifier: CHAT, route: 'linq-group-inbound' }]);
  });

  it('goes to the coach for a question about one of the family’s kids', async () => {
    await seedClaimedHousehold();
    const { deps, jobs } = door();

    const response = await handleLinqInboundRequest(
      signed(groupMessage('what time is Maya done tonight?', 'in-kid')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    expect(jobs).toHaveLength(1);
  });

  it(`holds the chat at ${RATE_LIMITS['linq-group-inbound'].limit} coach turns an hour, silently`, async () => {
    const { familyId } = await seedClaimedHousehold();
    const { deps, jobs, sends, transport } = door();
    const limit = RATE_LIMITS['linq-group-inbound'].limit;
    const spend = new PostgresRateLimiter(db.database);
    for (let i = 0; i < limit; i += 1) {
      await spend.check(CHAT, 'linq-group-inbound', RATE_LIMITS['linq-group-inbound']);
    }

    const response = await handleLinqInboundRequest(
      signed(groupMessage('Hale, is swim still on tomorrow', 'in-over')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'group_rate_limited' });
    expect(jobs).toEqual([]);
    expect(await inboundRows(familyId)).toEqual([]);
    expect(sends).toEqual([]);
    expect(transport.bodies()).toEqual([]);
  });

  it('routes chatter to the coach as today when the flag is dark', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    const { familyId } = await seedClaimedHousehold();
    const { deps, jobs } = door();

    const response = await handleLinqInboundRequest(
      signed(groupMessage('love you, see you tonight', 'in-dark')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    expect(jobs).toHaveLength(1);
    expect(await inboundRows(familyId)).toEqual([{ body: 'love you, see you tonight' }]);
    expect(await budgetRows()).toEqual([
      { identifier: phoneBlindIndex(PARENT), route: 'sms-inbound' },
    ]);
  });
});

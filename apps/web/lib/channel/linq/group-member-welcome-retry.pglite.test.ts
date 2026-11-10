import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { handleLinqInboundRequest } from './inbound';

/**
 * VIL-461 — the production wiring of the welcome retry: a seated member whose welcome
 * never landed speaks in the household group, and the Linq door sends that welcome
 * before the turn goes on.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const PARENT = '+14165550111';
const MEMBER = '+14165550122';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const CHAT = 'chat-family-group';
const WELCOME = 'Hi from Hale, Parent added you. What should I call you?';

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
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedVerified(familyId: string, phone: string, role: 'primary_parent' | 'extended') {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}`, name: 'Parent' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return userId;
}

/** A household group with a member a parent seated whose welcome never landed. */
async function seedUnwelcomedSeat(): Promise<void> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Parent', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentId = await seedVerified(familyId, PARENT, 'primary_parent');
  const memberId = await seedVerified(familyId, MEMBER, 'extended');
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId: memberId,
    phoneE164Encrypted: encryptString(MEMBER),
    phoneE164Hash: phoneBlindIndex(MEMBER),
    role: 'other_family',
    addedByUserId: parentId,
    seatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function signed(body: { event_id: string }): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET_BYTES)
    .update(`${body.event_id}.${TS}.${raw}`)
    .digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': body.event_id,
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function memberMessage(text: string, id: string) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: `evt_${id}`,
    created_at: NOW.toISOString(),
    data: {
      chat: { id: CHAT, is_group: true },
      id,
      direction: 'inbound',
      sender_handle: { handle: MEMBER, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
  };
}

function door() {
  const sends: Array<{ chatId: string; text: string }> = [];
  const intake: IntakeDeps = {
    transport: new FakeTransport(),
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new PostgresRateLimiter(db.database),
    now: NOW,
  };
  const deps = {
    database: db.database,
    intake: () => intake,
    enqueue: async (_job: ChannelMessageReceivedJob) => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
    groupVoice: fakeGroupOnboardingComposer({ body: WELCOME }),
    groupLimiter: new PostgresRateLimiter(db.database),
    sendGroupText: async (input: { chatId: string; text: string }) => {
      sends.push(input);
      return { providerMessageId: `out-${sends.length}` };
    },
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  return { deps, sends };
}

async function welcomedAt(): Promise<Date | null | undefined> {
  const [row] = await db.database
    .select({ welcomedAt: schema.linqGroupMembers.welcomedAt })
    .from(schema.linqGroupMembers)
    .where(eq(schema.linqGroupMembers.phoneE164Hash, phoneBlindIndex(MEMBER)));
  return row?.welcomedAt;
}

describe('the Linq door retries an unwelcomed member', () => {
  it('sends the welcome on the member’s next group message, once', async () => {
    await seedUnwelcomedSeat();
    const { deps, sends } = door();

    await handleLinqInboundRequest(signed(memberMessage('hi all', 'in-1')), deps);
    expect(sends).toEqual([{ chatId: CHAT, text: WELCOME }]);
    expect(await welcomedAt()).toEqual(NOW);

    await handleLinqInboundRequest(signed(memberMessage('see you sunday', 'in-2')), deps);
    expect(sends.filter((send) => send.text === WELCOME)).toHaveLength(1);
  });
});

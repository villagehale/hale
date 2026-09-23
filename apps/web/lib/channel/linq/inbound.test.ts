import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ChannelMessageReceivedJob, TwilioInboundDeps } from '~/lib/channel/twilio/inbound';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { handleLinqInboundRequest } from './inbound';

/**
 * The Linq door, end to end minus the network. The signature is computed from
 * Standard Webhooks, and the family is enrolled on the SMS blind index — the
 * continuity law this door must not fork.
 */

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const API_KEY = 'linq_test_key_not_a_secret';
const APP_URL = 'https://app.villagehale.com';
const INBOUND_URL = `${APP_URL}/api/channels/linq/inbound?version=2026-02-03`;
const PHONE = '+14165551234';
const CHAT_ID = '8f392755-6865-4b18-880a-227f9d8b458f';
const MESSAGE_ID = '89e3566e-1d13-49e5-a8ee-48490d5bfeb7';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: string): string {
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_fixture.${TS}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function messageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_fixture',
    created_at: NOW.toISOString(),
    data: {
      chat: { id: CHAT_ID, is_group: false },
      id: MESSAGE_ID,
      direction: 'inbound',
      sender_handle: { handle: PHONE, is_me: false },
      parts: [{ type: 'text', value: 'can you move swimming to Thursday?' }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
    ...overrides,
  });
}

function request(body: string, options: { signature?: string | null; url?: string } = {}): Request {
  const signature = options.signature === undefined ? sign(body) : options.signature;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) {
    headers['webhook-id'] = 'evt_fixture';
    headers['webhook-timestamp'] = TS;
    headers['webhook-signature'] = signature;
  }
  return new Request(options.url ?? INBOUND_URL, { method: 'POST', headers, body });
}

function enrol(fake: FakeDb): { familyId: string; userId: string } {
  const familyId = '00000000-0000-4000-8000-0000000000f1';
  const userId = '00000000-0000-4000-8000-0000000000u1';
  fake.db.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
  } as never);
  fake.db
    .insert(schema.familyMembers)
    .values({ userId, familyId, role: 'primary_parent' } as never);
  fake.db.insert(schema.smsIntakeSessions).values({
    phoneHash: phoneBlindIndex(PHONE),
    state: 'complete',
    closedAt: NOW,
  } as never);
  return { familyId, userId };
}

function harness(): { fake: FakeDb; jobs: ChannelMessageReceivedJob[]; deps: TwilioInboundDeps } {
  const fake = makeFakeDb();
  const jobs: ChannelMessageReceivedJob[] = [];
  const intake: IntakeDeps = {
    transport: new FakeTransport(),
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
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
  const deps: TwilioInboundDeps = {
    database: fake.db,
    intake: () => intake,
    enqueue: async (job) => {
      jobs.push(job);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
  };
  return { fake, jobs, deps };
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = ENC_KEY;
  vi.stubEnv('LINQ_API_KEY', API_KEY);
  vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('handleLinqInboundRequest', () => {
  it('answers 503 and writes nothing when the leg is not configured', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
    const h = harness();

    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'linq_not_configured' });
    expect(h.fake.writes).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });

  it('answers 503 when only one of the two secrets is set', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const h = harness();
    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);
    expect(res.status).toBe(503);
    expect(h.jobs).toHaveLength(0);
  });

  it('rejects a bad signature before any write', async () => {
    const h = harness();
    const res = await handleLinqInboundRequest(
      request(messageBody(), { signature: 'v1,aaaa' }),
      h.deps,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_signature' });
    expect(h.fake.writes).toHaveLength(0);
  });

  it('refuses a subscription URL that is not pinned to 2026-02-03', async () => {
    const h = harness();
    const body = messageBody();
    const res = await handleLinqInboundRequest(
      request(body, { url: `${APP_URL}/api/channels/linq/inbound` }),
      h.deps,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'unsupported_webhook_version' });
    expect(h.jobs).toHaveLength(0);
  });

  it('routes a signed 1:1 onto the family the SMS hash enrolled, and keeps the chat id', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);

    const res = await handleLinqInboundRequest(request(messageBody()), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'handed_off' });
    const message = h.fake
      .rows(schema.channelMessages)
      .find((row) => row.providerMessageId === MESSAGE_ID);
    expect(message).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      body: 'can you move swimming to Thursday?',
      providerChatId: CHAT_ID,
    });
    expect(h.jobs).toEqual([
      {
        family_id: familyId,
        parent_user_id: userId,
        channel_message_id: message?.id,
        provider_message_id: MESSAGE_ID,
        received_at: NOW.toISOString(),
      },
    ]);
  });

  it('acks a group chat by name and does not open a conversation', async () => {
    const h = harness();
    enrol(h.fake);
    const body = JSON.parse(messageBody()) as {
      data: { chat: { is_group: boolean } };
    };
    body.data.chat.is_group = true;
    const raw = JSON.stringify(body);

    const res = await handleLinqInboundRequest(request(raw), h.deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'group_ignored' });
    expect(h.jobs).toHaveLength(0);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('does not put the webhook secret or the message text in a refusal', async () => {
    const h = harness();
    const res = await handleLinqInboundRequest(
      request(messageBody(), { signature: 'v1,aaaa' }),
      h.deps,
    );
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('swimming');
    expect(text).not.toContain(API_KEY);
  });
});

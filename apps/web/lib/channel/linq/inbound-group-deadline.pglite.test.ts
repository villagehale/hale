import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleDutyMemory } from '~/lib/channel/coparent/duty/settle';
import { routeInboundText } from '~/lib/channel/inbound-route';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from './inbound';
import { LINQ_WEBHOOK_TIMEOUT_MS } from './signature';

/**
 * A duty ack in a family group runs inside Linq's webhook, so its tapback retry is bounded
 * by the moment Linq stops waiting for that webhook. Only the duty write and the hand-off
 * to the coach are replaced here: everything up to them is the real door on a real database.
 */
vi.mock('~/lib/channel/inbound-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/inbound-route')>()),
  routeInboundText: vi.fn(async () => 'handed_off'),
}));
vi.mock('~/lib/channel/coparent/duty/settle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/coparent/duty/settle')>()),
  settleDutyMemory: vi.fn(async () => ({
    status: 'skipped',
    reason: 'flag_off',
    sent: false,
    spoken: null,
  })),
}));

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const URL = 'https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03';
const PHONE = '+15555550130';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const MESSAGE = '89e3566e-1d13-49e5-a8ee-48490d5bfeb7';
// Linq started this attempt three seconds before the door ran.
const LINQ_SENT_AT = new Date('2026-09-23T12:00:00.000Z');
const NOW = new Date(LINQ_SENT_AT.getTime() + 3_000);
const TS = String(LINQ_SENT_AT.getTime() / 1000);

function signedGroupText(text: string): Request {
  const body = JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_fixture',
    created_at: LINQ_SENT_AT.toISOString(),
    data: {
      chat: { id: CHAT, is_group: true },
      id: MESSAGE,
      direction: 'inbound',
      sender_handle: { handle: PHONE, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: LINQ_SENT_AT.toISOString(),
      service: 'iMessage',
    },
  });
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_fixture.${TS}.${body}`).digest('base64');
  return new Request(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_fixture',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body,
  });
}

let db: TestDb;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('COPARENT_DUTY_ASKS_ENABLED', 'true');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'not this test' }, { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(settleDutyMemory).mockClear();
  vi.mocked(routeInboundText).mockClear();
});

describe('the Linq group door and the webhook deadline', () => {
  it('hands the duty ack the moment Linq stops waiting on this webhook', async () => {
    const family = await seedFamily(db.database, 'Group deadline');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: CHAT })
      .where(eq(schema.families.id, family.familyId));
    await db.database.insert(schema.parentChannels).values({
      userId: family.parentUserId,
      familyId: family.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
    });

    const res = await handleLinqInboundRequest(signedGroupText('I can take pickup Thursday'), {
      database: db.database,
      intake: () => {
        throw new Error('the coach hand-off is replaced above');
      },
      enqueue: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => NOW,
      markRead: async () => ({ status: 'accepted' }),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(settleDutyMemory)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(settleDutyMemory).mock.calls[0]?.[1]).toMatchObject({
      familyId: family.familyId,
      surface: 'group',
      inboundMessageId: MESSAGE,
      answerBy: new Date(LINQ_SENT_AT.getTime() + LINQ_WEBHOOK_TIMEOUT_MS),
    });
  });
});

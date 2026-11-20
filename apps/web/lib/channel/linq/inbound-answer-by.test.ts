import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InboundRouteDeps, routeInboundText } from '~/lib/channel/inbound-route';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { handleLinqInboundRequest } from './inbound';
import { LINQ_WEBHOOK_TIMEOUT_MS } from './signature';

/**
 * The 1:1 text intake answers inside Linq's webhook carries the moment Linq stops waiting
 * for that webhook, so a set of bubbles intake paces never runs past it. Only the hand-off
 * to the route is replaced here: everything up to it is the real door.
 */
vi.mock('~/lib/channel/inbound-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/inbound-route')>()),
  routeInboundText: vi.fn(async () => 'intake'),
}));

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const URL = 'https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03';
// Linq started this attempt three seconds before the door ran (a cold start, say).
const LINQ_SENT_AT = new Date('2026-09-23T12:00:00.000Z');
const NOW = new Date(LINQ_SENT_AT.getTime() + 3_000);
const TS = String(LINQ_SENT_AT.getTime() / 1000);

function signedRequest(body: string): Request {
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

function oneToOneText(): string {
  return JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_fixture',
    created_at: LINQ_SENT_AT.toISOString(),
    data: {
      chat: { id: '8f392755-6865-4b18-880a-227f9d8b458f', is_group: false },
      id: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
      direction: 'inbound',
      sender_handle: { handle: '+14165551234', is_me: false },
      parts: [{ type: 'text', value: 'Ada is 4, H0H 0H0' }],
      sent_at: LINQ_SENT_AT.toISOString(),
      service: 'iMessage',
    },
  });
}

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(routeInboundText).mockClear();
});

describe('the Linq door and the webhook deadline', () => {
  it('hands intake the moment Linq stops waiting: its own start plus its response timeout', async () => {
    const deps: InboundRouteDeps = {
      database: makeFakeDb().db,
      intake: () => {
        throw new Error('intake is past the replaced hand-off');
      },
      enqueue: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => NOW,
    };

    const res = await handleLinqInboundRequest(signedRequest(oneToOneText()), {
      ...deps,
      markRead: async () => ({ status: 'accepted' }),
    });

    await expect(res.json()).resolves.toEqual({ outcome: 'intake' });
    expect(vi.mocked(routeInboundText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeInboundText).mock.calls[0]?.[1]).toMatchObject({
      service: 'iMessage',
      answerBy: new Date(LINQ_SENT_AT.getTime() + LINQ_WEBHOOK_TIMEOUT_MS),
    });
  });
});

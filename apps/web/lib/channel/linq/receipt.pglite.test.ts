import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwilioInboundDeps } from '~/lib/channel/twilio/inbound';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from './inbound';

/**
 * Delivery receipts land on the same monotonic ledger write Twilio uses.
 * A read advances a sent row to delivered and is still named `message.read`
 * in the response, so pacing can tell a read from a first delivery. A later
 * read does not move a row that is already delivered. A failure stores the
 * numeric code and not Linq's free-text reason.
 */

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const API_KEY = 'linq_test_key_not_a_secret';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const CHAT_ID = '8f392755-6865-4b18-880a-227f9d8b458f';
const OUT_ID = '347d62c2-2170-4754-8d30-c76d0c727d96';

function sign(body: string): string {
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_receipt.${TS}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function receiptRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_receipt',
      'webhook-timestamp': TS,
      'webhook-signature': sign(raw),
    },
    body: raw,
  });
}

function envelope(event: string, data: Record<string, unknown>) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: event,
    event_id: 'evt_receipt',
    data,
  };
}

describe('linq delivery receipts', () => {
  let db: TestDb;

  beforeEach(async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
    db = await createTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedOutbound(status: 'sent' | 'delivered') {
    const family = await seedFamily(db.database);
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status,
      providerMessageId: OUT_ID,
      providerChatId: CHAT_ID,
    });
  }

  function deps(): TwilioInboundDeps {
    return {
      database: db.database,
      intake: () => {
        throw new Error('a receipt must not build intake');
      },
      enqueue: async () => {
        throw new Error('a receipt must not enqueue');
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => NOW,
    };
  }

  async function statusOf(): Promise<{ status: string; errorCode: string | null } | undefined> {
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.providerMessageId, OUT_ID));
    return row;
  }

  it('advances a sent row to delivered, and a read does the same without a second status', async () => {
    await seedOutbound('sent');
    const delivered = await handleLinqInboundRequest(
      receiptRequest(
        envelope('message.delivered', {
          id: OUT_ID,
          chat: { id: CHAT_ID, is_group: false },
          delivered_at: NOW.toISOString(),
        }),
      ),
      deps(),
    );
    expect(delivered.status).toBe(200);
    await expect(delivered.json()).resolves.toEqual({ outcome: 'receipt', apply: 'updated' });
    expect(await statusOf()).toEqual({ status: 'delivered', errorCode: null });

    const read = await handleLinqInboundRequest(
      receiptRequest(
        envelope('message.read', {
          id: OUT_ID,
          chat: { id: CHAT_ID, is_group: false },
          read_at: NOW.toISOString(),
        }),
      ),
      deps(),
    );
    await expect(read.json()).resolves.toEqual({ outcome: 'receipt', apply: 'ignored' });
    expect(await statusOf()).toEqual({ status: 'delivered', errorCode: null });
  });

  it('stores a failure code and leaves the reason text out of the row', async () => {
    await seedOutbound('sent');
    const res = await handleLinqInboundRequest(
      receiptRequest(
        envelope('message.failed', {
          chat_id: CHAT_ID,
          message_id: OUT_ID,
          code: 4001,
          reason: 'the parent wrote something private',
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'receipt', apply: 'updated' });
    expect(await statusOf()).toEqual({ status: 'failed', errorCode: '4001' });
  });

  it('names a receipt for a message this deployment never wrote', async () => {
    const res = await handleLinqInboundRequest(
      receiptRequest(envelope('message.delivered', { id: OUT_ID, chat: { id: CHAT_ID } })),
      deps(),
    );
    await expect(res.json()).resolves.toEqual({
      outcome: 'receipt',
      apply: 'unknown_message',
    });
  });
});

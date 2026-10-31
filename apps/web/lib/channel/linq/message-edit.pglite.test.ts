import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundRouteDeps } from '~/lib/channel/inbound-route';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from './inbound';

/**
 * VIL-479 · `message.edited` lands on the transcript (our edit) or the inbound
 * body (a parent's edit). The text is not a log line. A retry does not audit twice.
 */

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const API_KEY = 'linq_test_key_not_a_secret';
const NOW = new Date('2026-10-31T16:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const CHAT_ID = '8f392755-6865-4b18-880a-227f9d8b458f';
const OUT_ID = '347d62c2-2170-4754-8d30-c76d0c727d96';
const EDITED = 'Swim is at 5.';

function sign(body: string): string {
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_edit.${TS}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function editRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_edit',
      'webhook-timestamp': TS,
      'webhook-signature': sign(raw),
    },
    body: raw,
  });
}

function envelope(data: Record<string, unknown>) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.edited',
    event_id: 'evt_edit',
    data,
  };
}

describe('linq message.edited webhook', () => {
  let db: TestDb;
  const info = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
    db = await createTestDb();
    info.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function deps(): InboundRouteDeps {
    return {
      database: db.database,
      intake: () => {
        throw new Error('an edit must not build intake');
      },
      enqueue: async () => {
        throw new Error('an edit must not enqueue');
      },
      log: { info, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => NOW,
    };
  }

  it('rewrites the sent bubble, ignores the text in the log, and does not audit a retry', async () => {
    const family = await seedFamily(db.database);
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId: family.familyId })
      .returning({ id: schema.conversations.id });
    if (!conversation) throw new Error('conversation missing');
    await db.database.insert(schema.messages).values({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Swim is at 4.',
      providerMessageId: OUT_ID,
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      providerMessageId: OUT_ID,
      providerChatId: CHAT_ID,
      relatedConversationId: conversation.id,
      sentAt: NOW,
    });

    const body = envelope({
      id: OUT_ID,
      direction: 'outbound',
      chat: { id: CHAT_ID, is_group: false },
      sender_handle: { handle: '+14375550100', is_me: true },
      part: { index: 0, text: EDITED },
      edited_at: NOW.toISOString(),
    });
    const first = await handleLinqInboundRequest(editRequest(body), deps());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ outcome: 'message_edited', apply: 'updated' });
    const second = await handleLinqInboundRequest(editRequest(body), deps());
    await expect(second.json()).resolves.toEqual({ outcome: 'message_edited', apply: 'unchanged' });

    const [bubble] = await db.database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.providerMessageId, OUT_ID));
    expect(bubble?.content).toBe(EDITED);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_message_edited'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain(EDITED);

    const malformed = await handleLinqInboundRequest(
      editRequest(envelope({ id: OUT_ID, direction: 'outbound' })),
      deps(),
    );
    await expect(malformed.json()).resolves.toEqual({ outcome: 'malformed' });
  });

  it('names a provider id this deployment never sent', async () => {
    const res = await handleLinqInboundRequest(
      editRequest(
        envelope({
          id: OUT_ID,
          direction: 'outbound',
          part: { index: 0, text: EDITED },
        }),
      ),
      deps(),
    );
    await expect(res.json()).resolves.toEqual({
      outcome: 'message_edited',
      apply: 'unknown_message',
    });
  });
});

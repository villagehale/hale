import { createHash } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { sendOneToOne } from '~/lib/channel/linq/connect-link-1to1';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import {
  beginParentSend,
  completeParentSend,
  deliverParentText,
  parentLinqKey,
} from '~/lib/channel/parent-send';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const API_KEY = 'linq_test_key_not_a_secret';
const LOGICAL = 'linq:coparent_welcome:parent-1';
const BODY = 'Swim is at ten. I can take Maya.';

function linqKey(familyId: string): string {
  return createHash('sha256').update(parentLinqKey(familyId, LOGICAL)).digest('hex');
}

function idempotencyOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as { message?: { idempotency_key?: string } };
  const key = body.message?.idempotency_key;
  if (!key) throw new Error('expected an idempotency key');
  return key;
}

function textOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as {
    message?: { parts?: Array<{ value?: string }> };
  };
  return body.message?.parts?.[0]?.value ?? '';
}

function pager(): { pager: OpsPager; pages: OpsPage[] } {
  const pages: OpsPage[] = [];
  return {
    pages,
    pager: {
      async page(page) {
        pages.push(page);
        return 'paged';
      },
    },
  };
}

describe('deliverParentText through Linq, fetch stubbed', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const family = await seedFamily(db.database);
    familyId = family.familyId;
    parentUserId = family.parentUserId;
  });

  beforeEach(() => {
    vi.stubEnv('PARENT_SEND_RECEIPT_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('VERCEL_ENV', 'development');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function row() {
    const [found] = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
        providerMessageId: schema.channelMessages.providerMessageId,
        dedupeKey: schema.channelMessages.dedupeKey,
        body: schema.channelMessages.body,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, LOGICAL));
    return found ?? null;
  }

  function send(fetchImpl: typeof fetch) {
    return (sendKey: string) =>
      sendLinqChatMessage({
        chatId: CHAT,
        text: BODY,
        sendKey,
        fetch: fetchImpl,
      }).then((sent) => ({ providerMessageId: sent.providerMessageId, chatId: CHAT }));
  }

  it('a timeout and then a success reuses one key and sends once', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init);
      if (calls.length === 1) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }
      return Response.json({ message: { id: 'msg-landed' } }, { status: 201 });
    };
    const ops = pager();
    const now = new Date();
    const first = await deliverParentText(db.database, {
      familyId,
      parentUserId,
      logicalKey: LOGICAL,
      channel: 'imessage',
      category: 'reply',
      templateKey: 'linq:coparent_welcome',
      providerChatId: CHAT,
      now,
      recordBody: null,
      surface: 'group_line',
      final: false,
      pager: ops.pager,
      send: send(fetchImpl),
    });
    expect(first.outcome).toBe('unknown');
    const held = await row();
    expect(held?.status).toBe('failed');
    expect(held?.providerMessageId).toBeNull();
    expect(SENT_STATUSES).not.toContain(held?.status);

    const second = await deliverParentText(db.database, {
      familyId,
      parentUserId,
      logicalKey: LOGICAL,
      channel: 'imessage',
      category: 'reply',
      templateKey: 'linq:coparent_welcome',
      providerChatId: CHAT,
      now: new Date(),
      recordBody: null,
      surface: 'group_line',
      final: false,
      pager: ops.pager,
      send: send(fetchImpl),
    });
    expect(second).toMatchObject({ outcome: 'sent', providerMessageId: 'msg-landed' });
    expect(calls.map((init) => idempotencyOf(init))).toEqual([
      linqKey(familyId),
      linqKey(familyId),
    ]);
    expect(calls.map((init) => textOf(init))).toEqual([BODY, BODY]);
    expect(ops.pages).toEqual([]);
    const landed = await row();
    expect(landed?.status).toBe('sent');
    expect(landed?.providerMessageId).toBe('msg-landed');
  });

  // Postgres stores microseconds and a JS Date keeps milliseconds, and pglite's clock hides
  // the gap, so these two give the row the time real Postgres would.
  const storeWithMicroseconds = (id: string, at: Date) =>
    db.exec(
      `update channel_messages set created_at = '${at.toISOString()}'::timestamptz + interval '123 microseconds' where id = '${id}'`,
    );

  const receiptInput = (now: Date, logicalKey: string) => ({
    familyId,
    parentUserId,
    logicalKey,
    channel: 'imessage' as const,
    category: 'reply' as const,
    templateKey: 'linq:coparent_welcome',
    providerChatId: CHAT,
    now,
    recordBody: null,
    surface: 'group_line' as const,
    final: false,
    pager: pager().pager,
    send: async () => ({ providerMessageId: 'msg-landed', chatId: CHAT }),
  });

  it('records the text as sent when the stored claim time has microseconds', async () => {
    const now = new Date();
    const input = receiptInput(now, `${LOGICAL}:microseconds-sent`);
    const begun = await beginParentSend(db.database, input);
    if (begun.state !== 'owned') throw new Error(`expected a claim, got ${begun.state}`);
    await storeWithMicroseconds(begun.owned.claimId, begun.owned.claimAt);

    const result = await completeParentSend(db.database, begun.owned, input);

    expect(result).toMatchObject({ outcome: 'sent', providerMessageId: 'msg-landed' });
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, begun.owned.claimId));
    expect(SENT_STATUSES as readonly string[]).toContain(row?.status);
    expect(row).toMatchObject({ errorCode: null, providerMessageId: 'msg-landed' });
  });

  it('takes over a crashed claim whose stored time has microseconds', async () => {
    const claimedAt = new Date(Date.now() - 60 * 60 * 1000);
    const key = `${LOGICAL}:microseconds-crashed`;
    const first = await beginParentSend(db.database, receiptInput(claimedAt, key));
    if (first.state !== 'owned') throw new Error(`expected a claim, got ${first.state}`);
    await storeWithMicroseconds(first.owned.claimId, claimedAt);

    const second = await beginParentSend(db.database, receiptInput(new Date(), key));

    expect(second.state).toBe('owned');
  });

  it('a Linq refusal leaves the row unsent and pages', async () => {
    const key = 'linq:coparent_welcome:refused';
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: { code: 400 } }, { status: 400 });
    const ops = pager();
    const result = await deliverParentText(db.database, {
      familyId,
      parentUserId,
      logicalKey: key,
      channel: 'imessage',
      category: 'reply',
      templateKey: 'linq:coparent_welcome',
      providerChatId: CHAT,
      now: new Date(),
      recordBody: null,
      surface: 'one_to_one',
      final: false,
      pager: ops.pager,
      send: (sendKey) =>
        sendLinqChatMessage({
          chatId: CHAT,
          text: BODY,
          sendKey,
          fetch: fetchImpl,
        }).then((sent) => ({ providerMessageId: sent.providerMessageId, chatId: CHAT })),
    });
    expect(result.outcome).toBe('refused');
    const [held] = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, key));
    expect(held?.status).toBe('failed');
    expect(held?.providerMessageId).toBeNull();
    expect(SENT_STATUSES).not.toContain(held?.status);
    expect(ops.pages).toEqual([
      {
        site: 'parent_send_unsent',
        facts: { surface: 'one_to_one', reason: 'send_refused' },
        count: 1,
      },
    ]);
  });

  it('a second claim of a row just taken does not send', async () => {
    const key = 'linq:coparent_welcome:twice';
    let posts = 0;
    const fetchImpl: typeof fetch = async () => {
      posts += 1;
      return Response.json({ message: { id: 'msg-once' } }, { status: 201 });
    };
    const fields = {
      familyId,
      parentUserId,
      logicalKey: key,
      channel: 'imessage' as const,
      category: 'reply' as const,
      templateKey: 'linq:coparent_welcome',
      providerChatId: CHAT,
      now: new Date(),
      recordBody: null,
      surface: 'group_line' as const,
    };
    const first = await beginParentSend(db.database, fields);
    const second = await beginParentSend(db.database, fields);
    expect(first.state).toBe('owned');
    expect(second.state).toBe('in_flight');
    if (first.state !== 'owned') return;
    const done = await completeParentSend(db.database, first.owned, {
      ...fields,
      final: false,
      pager: pager().pager,
      send: (sendKey) =>
        sendLinqChatMessage({
          chatId: CHAT,
          text: BODY,
          sendKey,
          fetch: fetchImpl,
        }).then((sent) => ({ providerMessageId: sent.providerMessageId, chatId: CHAT })),
    });
    expect(done).toMatchObject({ outcome: 'sent', providerMessageId: 'msg-once' });
    expect(posts).toBe(1);
  });
});

describe('sendOneToOne', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const family = await seedFamily(db.database);
    familyId = family.familyId;
    parentUserId = family.parentUserId;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('with the flag off, a refusal still drops the dedupe key', async () => {
    vi.stubEnv('PARENT_SEND_RECEIPT_ENABLED', '');
    const key = 'one-to-one:flag-off';
    const result = await sendOneToOne(db.database, {
      familyId,
      ledgerUserId: parentUserId,
      to: '+15555550123',
      body: BODY,
      recordBody: false,
      templateKey: 'linq:connect_link_off',
      dedupeKey: key,
      now: new Date(),
      send: {
        text: async () => {
          throw new LinqSendError('http_400', 400, true);
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
    });
    expect(result).toMatchObject({ outcome: 'not_sent', permanent: true });
    const [held] = await db.database
      .select({
        status: schema.channelMessages.status,
        dedupeKey: schema.channelMessages.dedupeKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, 'linq:connect_link_off'));
    expect(held?.status).toBe('failed');
    expect(held?.dedupeKey).toBeNull();
  });

  it('with the flag on, a retry of the 1:1 door reuses the Linq key', async () => {
    vi.stubEnv('PARENT_SEND_RECEIPT_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('VERCEL_ENV', 'development');
    const key = 'one-to-one:flag-on';
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init);
      if (calls.length === 1) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }
      return Response.json({ message: { id: 'msg-1to1' } }, { status: 201 });
    };
    const door = {
      text: async (input: { to: string; body: string; sendKey?: string }) => {
        const sent = await sendLinqChatMessage({
          chatId: CHAT,
          text: input.body,
          sendKey: input.sendKey,
          fetch: fetchImpl,
        });
        return { providerMessageId: sent.providerMessageId, chatId: CHAT };
      },
      link: async () => ({ providerMessageId: 'unused' }),
    };
    const first = await sendOneToOne(db.database, {
      familyId,
      ledgerUserId: parentUserId,
      to: '+15555550123',
      body: BODY,
      recordBody: true,
      templateKey: 'linq:connect_link_1to1',
      dedupeKey: key,
      now: new Date(),
      send: door,
    });
    expect(first).toMatchObject({ outcome: 'not_sent', permanent: false });
    const second = await sendOneToOne(db.database, {
      familyId,
      ledgerUserId: parentUserId,
      to: '+15555550123',
      body: BODY,
      recordBody: true,
      templateKey: 'linq:connect_link_1to1',
      dedupeKey: key,
      now: new Date(),
      send: door,
    });
    expect(second).toMatchObject({ outcome: 'sent', providerMessageId: 'msg-1to1' });
    const expected = createHash('sha256').update(parentLinqKey(familyId, key)).digest('hex');
    expect(calls.map((init) => idempotencyOf(init))).toEqual([expected, expected]);
    expect(calls.map((init) => textOf(init))).toEqual([BODY, BODY]);
    const [held] = await db.database
      .select({
        status: schema.channelMessages.status,
        body: schema.channelMessages.body,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, key));
    expect(held).toMatchObject({ status: 'sent', body: BODY, providerMessageId: 'msg-1to1' });
  });
});

describe('a threaded reply', () => {
  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('VERCEL_ENV', 'development');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('with the flag off, a 409 is sent again under a new key', async () => {
    vi.stubEnv('PARENT_SEND_RECEIPT_ENABLED', '');
    const keys: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      keys.push(idempotencyOf(init));
      if (keys.length === 1) return Response.json({ error: { code: 409 } }, { status: 409 });
      return Response.json({ message: { id: 'msg-plain' } }, { status: 201 });
    };
    const sent = await sendLinqChatMessage({
      chatId: CHAT,
      text: BODY,
      sendKey: 'turn-reply:in-1:0',
      replyTo: { messageId: 'msg-in-1' },
      fetch: fetchImpl,
    });
    expect(sent.providerMessageId).toBe('msg-plain');
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('with the flag on, a 409 is not sent again under a new key', async () => {
    vi.stubEnv('PARENT_SEND_RECEIPT_ENABLED', 'true');
    const keys: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      keys.push(idempotencyOf(init));
      return Response.json({ error: { code: 409 } }, { status: 409 });
    };
    await expect(
      sendLinqChatMessage({
        chatId: CHAT,
        text: BODY,
        sendKey: 'turn-reply:in-1:0',
        replyTo: { messageId: 'msg-in-1' },
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(keys).toHaveLength(1);
  });
});

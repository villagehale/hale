import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { noteDeadLetteredTurn } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { LateNoteFacts } from './compose';
import { ackDeadlinePorts } from './production';
import { recordAckPromise } from './promise';
import { type AckDeadlinePorts, runAckDeadlineSweep } from './sweep';

/**
 * VIL-717 · the late note on the production wiring and the real Linq door, with only `fetch`
 * stubbed. The stand-in Linq keeps one bubble per idempotency key, as the real one does. The
 * writer is a stand-in because what the model says is the cached eval's job (rule #8).
 */

const ASKED_AT = new Date('2025-11-20T15:00:00.000Z');
const ACK_AT = new Date('2025-11-20T15:00:20.000Z');
const AFTER_DUE = new Date(ACK_AT.getTime() + 5.5 * 60_000);
const NEXT_TICK = new Date(AFTER_DUE.getTime() + 60_000);
const OLD_PHONE = '+15550000101';
const NEW_PHONE = '+15550000102';
const SENDING_LINE = '+15555550199';
const OLD_CHAT = 'chat-old-number';
const NEW_CHAT = 'chat-new-number';
const ASK_MESSAGE = 'parent-msg-1';
const NOTE = 'a stand-in late note';

let db: TestDb;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('ACK_ETA_ENABLED', 'true');
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'test-key-not-a-secret');
  vi.stubEnv('LINQ_FROM_E164', SENDING_LINE);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

type Post = { path: string; key?: string; replyTo?: string; to?: string[]; text?: string };

/** Linq's side of the wire. `directChats` is each number's 1:1 on Hale's line. */
function stubLinq(input: {
  directChats: Record<string, string>;
  /** The status of each threaded POST in turn. Past the list: 200. */
  threadedStatuses?: Array<{ status: number; landed: boolean }>;
}) {
  const posts: Post[] = [];
  const bubbles: string[] = [];
  const seen = new Set<string>();
  const scripted = [...(input.threadedStatuses ?? [])];
  let id = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (rawUrl: string, init?: RequestInit) => {
      const url = new URL(rawUrl);
      if ((init?.method ?? 'GET') === 'GET') {
        const chat = input.directChats[url.searchParams.get('to') ?? ''];
        return json({ chats: chat ? [{ id: chat, is_group: false }] : [] });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        to?: string[];
        message?: {
          idempotency_key?: string;
          reply_to?: { message_id?: string };
          parts?: Array<{ value?: string }>;
        };
      };
      const text = body.message?.parts?.[0]?.value;
      const key = body.message?.idempotency_key;
      const replyTo = body.message?.reply_to?.message_id;
      posts.push({
        path: url.pathname,
        ...(key ? { key } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(body.to ? { to: body.to } : {}),
        ...(text ? { text } : {}),
      });
      const outcome = replyTo ? scripted.shift() : undefined;
      const lands = outcome ? outcome.landed : true;
      if (lands && text && (!key || !seen.has(key))) bubbles.push(text);
      if (lands && key) seen.add(key);
      if (outcome && outcome.status >= 400) {
        return json({ error: { code: `http_${outcome.status}` } }, outcome.status);
      }
      id += 1;
      return url.pathname.endsWith('/messages')
        ? json({ message: { id: `linq-${id}` } })
        : json({
            chat: {
              id: input.directChats[body.to?.[0] ?? ''] ?? 'chat-created',
              message: { id: `linq-${id}` },
            },
          });
    }),
  );
  return { posts, bubbles };
}

async function seedNote(input: { replyToMessageId?: string | null; phone?: string } = {}) {
  const phone = input.phone ?? OLD_PHONE;
  const { familyId, parentUserId } = await seedFamily(db.database);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: ASKED_AT,
  });
  await db.database.insert(schema.consentRecords).values({
    userId: parentUserId,
    familyId,
    consentType: 'proactive_watch',
    consentScope: WATCH_CONSENT_SCOPE,
    granted: true,
    policyVersion: POLICY_VERSION,
    evidence: { verbatimReply: 'an invented yes' },
  });
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'an invented slow ask',
      providerChatId: OLD_CHAT,
    })
    .returning({ id: schema.channelMessages.id });
  const [ack] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      templateKey: 'ack_eta',
    })
    .returning({ id: schema.channelMessages.id });
  if (!inbound || !ack) throw new Error('seed: channel_messages insert returned no row');
  const recorded = await recordAckPromise(db.database, {
    familyId,
    parentUserId,
    inboundChannelMessageId: inbound.id,
    ackChannelMessageId: ack.id,
    task: 'find',
    channel: 'imessage',
    providerChatId: OLD_CHAT,
    replyToMessageId: input.replyToMessageId === undefined ? ASK_MESSAGE : input.replyToMessageId,
    language: 'en',
    askedAt: ASKED_AT,
    promisedMinutes: 5,
    now: ACK_AT,
  });
  if (recorded.status !== 'recorded') throw new Error(`seed: promise ${recorded.status}`);
  return { familyId, parentUserId, inboundId: inbound.id, promiseId: recorded.promiseId };
}

/** What enrolVerifiedChannel leaves behind on a number change: revoke, then a new live row. */
async function moveNumber(seeded: { familyId: string; parentUserId: string }) {
  await db.database
    .update(schema.parentChannels)
    .set({ revokedAt: ACK_AT })
    .where(
      and(
        eq(schema.parentChannels.userId, seeded.parentUserId),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(NEW_PHONE),
    phoneE164Hash: phoneBlindIndex(NEW_PHONE),
    verifiedAt: ACK_AT,
  });
}

function wired(overrides: Partial<AckDeadlinePorts> = {}) {
  const facts: LateNoteFacts[] = [];
  const ports: AckDeadlinePorts = {
    ...ackDeadlinePorts(db.database),
    writer: {
      ack: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
      lateNote: async (input) => {
        facts.push(input);
        return { status: 'composed', line: NOTE };
      },
    },
    page: async () => 'paged',
    thread: async () => undefined,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
  return { ports, facts };
}

async function promiseRow(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.ackPromises)
    .where(eq(schema.ackPromises.id, id));
  return row;
}

async function noteRow(familyId: string) {
  const rows = await db.database
    .select({ chat: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, 'ack_eta_late_note'),
      ),
    );
  return rows;
}

describe('VIL-717 · the late note goes to the number the parent has now', () => {
  it('a number moved after the ask: nothing to the old chat, one text to the new number', async () => {
    const seeded = await seedNote();
    await moveNumber(seeded);
    const linq = stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT, [NEW_PHONE]: NEW_CHAT } });

    const tick = await runAckDeadlineSweep(db.database, wired().ports, AFTER_DUE);

    expect(tick.settled).toEqual({ sent: 1 });
    expect(linq.posts.filter((post) => post.path.includes(OLD_CHAT))).toEqual([]);
    expect(linq.posts).toHaveLength(1);
    expect(linq.posts[0]).toMatchObject({
      path: '/api/partner/v3/chats',
      to: [NEW_PHONE],
      text: NOTE,
    });
    expect(await noteRow(seeded.familyId)).toEqual([{ chat: NEW_CHAT }]);
  });

  it('the same number: threaded into the stored chat, under the ask', async () => {
    const seeded = await seedNote();
    const linq = stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT } });

    const tick = await runAckDeadlineSweep(db.database, wired().ports, AFTER_DUE);

    expect(tick.settled).toEqual({ sent: 1 });
    expect(linq.posts).toHaveLength(1);
    expect(linq.posts[0]).toMatchObject({
      path: `/api/partner/v3/chats/${OLD_CHAT}/messages`,
      replyTo: ASK_MESSAGE,
      text: NOTE,
    });
    expect(await noteRow(seeded.familyId)).toEqual([{ chat: OLD_CHAT }]);
  });

  it('no message to thread under: to the current number, unthreaded', async () => {
    const seeded = await seedNote({ replyToMessageId: null });
    await moveNumber(seeded);
    const linq = stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT, [NEW_PHONE]: NEW_CHAT } });

    await runAckDeadlineSweep(db.database, wired().ports, AFTER_DUE);

    expect(linq.posts).toHaveLength(1);
    expect(linq.posts[0]).toMatchObject({ path: '/api/partner/v3/chats', to: [NEW_PHONE] });
    expect(linq.posts[0]?.replyTo).toBeUndefined();
  });
});

describe('VIL-717 · a threaded send Linq answered unclearly', () => {
  it('a 409 after Linq took the text: no plain resend, and the next tick keeps the key', async () => {
    const seeded = await seedNote();
    const linq = stubLinq({
      directChats: { [OLD_PHONE]: OLD_CHAT },
      threadedStatuses: [{ status: 409, landed: true }],
    });
    const { ports } = wired();

    const first = await runAckDeadlineSweep(db.database, ports, AFTER_DUE);

    expect(first).toMatchObject({ released: 1, settled: {} });
    expect(linq.posts).toHaveLength(1);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ claimedAt: null, outcome: null });

    const second = await runAckDeadlineSweep(db.database, ports, NEXT_TICK);

    expect(second.settled).toEqual({ sent: 1 });
    expect(linq.bubbles).toEqual([NOTE]);
    expect(linq.posts).toHaveLength(2);
    expect(linq.posts[1]?.key).toBe(linq.posts[0]?.key);
  });

  it('a certain refusal of the thread target: resent plain in the same chat', async () => {
    const seeded = await seedNote();
    const linq = stubLinq({
      directChats: { [OLD_PHONE]: OLD_CHAT },
      threadedStatuses: [{ status: 422, landed: false }],
    });

    const tick = await runAckDeadlineSweep(db.database, wired().ports, AFTER_DUE);

    expect(tick.settled).toEqual({ sent: 1 });
    expect(linq.bubbles).toEqual([NOTE]);
    expect(linq.posts).toHaveLength(2);
    expect(linq.posts[1]).toMatchObject({ path: `/api/partner/v3/chats/${OLD_CHAT}/messages` });
    expect(linq.posts[1]?.replyTo).toBeUndefined();
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'sent' });
  });
});

describe('VIL-717 · the gate on the send clock', () => {
  it.each(['sends_paused', 'opt_out_unread', 'quiet_hours'] as const)(
    '%s while the note was written: the claim goes back and the next tick sends',
    async (reason) => {
      const seeded = await seedNote();
      const linq = stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT } });
      const verdicts: Array<'hold' | 'allow'> = ['allow', 'hold'];
      const { ports } = wired({
        gate: async () =>
          verdicts.shift() === 'hold'
            ? { allowed: false, reason }
            : { allowed: true, optOut: 'short' },
      });

      const first = await runAckDeadlineSweep(db.database, ports, AFTER_DUE);

      expect(first).toMatchObject({ released: 1, settled: {} });
      expect(linq.posts).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ claimedAt: null, outcome: null });

      const second = await runAckDeadlineSweep(db.database, ports, NEXT_TICK);

      expect(second.settled).toEqual({ sent: 1 });
      expect(linq.bubbles).toEqual([NOTE]);
    },
  );

  it.each(['not_enrolled', 'no_watch_consent'] as const)(
    '%s while the note was written: it ends held and no tick tries again',
    async (reason) => {
      const seeded = await seedNote();
      const linq = stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT } });
      const verdicts: Array<'hold' | 'allow'> = ['allow', 'hold'];
      const { ports } = wired({
        gate: async () =>
          verdicts.shift() === 'hold'
            ? { allowed: false, reason }
            : { allowed: true, optOut: 'short' },
      });

      const first = await runAckDeadlineSweep(db.database, ports, AFTER_DUE);
      const second = await runAckDeadlineSweep(db.database, ports, NEXT_TICK);

      expect(first.settled).toEqual({ held: 1 });
      expect(second).toMatchObject({ due: 0, claimed: 0 });
      expect(linq.posts).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'held' });
      const audits = await db.database
        .select({ after: schema.auditLog.after })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'ack_eta_deadline'));
      expect(audits.map((row) => row.after)).toContainEqual(
        expect.objectContaining({ outcome: 'held', reason }),
      );
    },
  );
});

describe('VIL-717 · a turn that ran out of retries before the ceiling', () => {
  it('its dead letter makes the note say it stopped, with no new window', async () => {
    const seeded = await seedNote();
    stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT } });
    await noteDeadLetteredTurn(db.database, {
      familyId: seeded.familyId,
      channelMessageId: seeded.inboundId,
      jobId: '11111111-1111-4111-8111-111111111111',
    });
    const { ports, facts } = wired();

    const tick = await runAckDeadlineSweep(db.database, ports, AFTER_DUE);

    expect(tick.settled).toEqual({ sent: 1 });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ status: 'stopped', newWithinMinutes: null });
  });

  it('another text dead-lettered: this note still says Hale is working on it', async () => {
    await seedNote();
    const other = await seedNote({ phone: NEW_PHONE });
    stubLinq({ directChats: { [OLD_PHONE]: OLD_CHAT } });
    await noteDeadLetteredTurn(db.database, {
      familyId: other.familyId,
      channelMessageId: other.inboundId,
      jobId: '11111111-1111-4111-8111-111111111111',
    });
    await db.database.delete(schema.ackPromises).where(eq(schema.ackPromises.id, other.promiseId));
    const { ports, facts } = wired();

    await runAckDeadlineSweep(db.database, ports, AFTER_DUE);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ status: 'still_working' });
    expect(facts[0]?.newWithinMinutes).toBeGreaterThan(5);
  });
});

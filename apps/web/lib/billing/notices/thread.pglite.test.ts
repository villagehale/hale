import { schema } from '@hale/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { payerThreadProof } from './thread';

/**
 * VIL-735 · a parent has a thread when they have texted Hale in the chat Linq holds for
 * Hale's line and their current number. A send to anyone else opens a chat: Hale would
 * be texting first.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-direct-1';
const SESSION_AT = new Date('2026-11-22T17:00:00Z');
const BEFORE = new Date(SESSION_AT.getTime() - 86_400_000);
const AFTER = new Date(SESSION_AT.getTime() + 300_000);
const PHONE = '+14165550101';

let db: TestDb;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: `${phoneBlindIndex(PHONE)}-${familyId}`,
    verifiedAt: new Date('2026-10-01T12:00:00Z'),
  });
});

async function inbound(over: {
  channel?: 'sms' | 'imessage';
  chatId?: string | null;
  sentAt?: Date | null;
  createdAt?: Date;
  inGroup?: boolean | null;
}) {
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: over.channel ?? 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: over.chatId === undefined ? CHAT : over.chatId,
    sentAt: over.sentAt === undefined ? BEFORE : over.sentAt,
    createdAt: over.createdAt ?? BEFORE,
    inGroup: over.inGroup === undefined ? null : over.inGroup,
  });
}

const proof = (
  before: Date | null,
  findDirectChat = async (_phone: string) => CHAT as string | null,
) => payerThreadProof(db.database, parentUserId, { before, findDirectChat });

describe('payerThreadProof', () => {
  it('an inbound text in Linq’s direct chat with in_group unset is a thread', async () => {
    await inbound({ inGroup: null });
    await expect(proof(SESSION_AT)).resolves.toBe('thread');
  });

  it('asks Linq about the parent’s current number', async () => {
    await inbound({});
    const find = vi.fn(async (_phone: string) => CHAT as string | null);
    await proof(null, find);
    expect(find).toHaveBeenCalledWith(PHONE);
  });

  it('an old inbound sms row and nothing in the Linq chat is no thread', async () => {
    await inbound({ channel: 'sms', chatId: null });
    await expect(proof(SESSION_AT)).resolves.toBe('no_thread');
  });

  it('a Linq chat the parent never texted (only Hale’s login code) is no thread', async () => {
    await expect(proof(SESSION_AT)).resolves.toBe('no_thread');
  });

  it('only group-chat rows is no thread', async () => {
    await inbound({ chatId: 'chat-group-1', inGroup: true });
    await expect(proof(SESSION_AT)).resolves.toBe('no_thread');
  });

  it('no chat with Hale’s line is no thread', async () => {
    await inbound({});
    await expect(proof(SESSION_AT, async () => null)).resolves.toBe('no_thread');
  });

  it('a parent with no sendable number is no thread, and Linq is not asked', async () => {
    const { parentUserId: bare } = await seedFamily(db.database, 'Bare Family');
    const find = vi.fn(async (_phone: string) => CHAT as string | null);
    await expect(
      payerThreadProof(db.database, bare, { before: null, findDirectChat: find }),
    ).resolves.toBe('no_thread');
    expect(find).not.toHaveBeenCalled();
  });

  it('a text replayed from intake after the session does not count for a payment', async () => {
    await inbound({ sentAt: AFTER, createdAt: AFTER });
    await expect(proof(SESSION_AT)).resolves.toBe('no_thread');
    // Positive control: the same row counts when the notice is not bound to a session.
    await expect(proof(null)).resolves.toBe('thread');
  });

  it('a text before the session counts for a payment, by sent_at or by created_at', async () => {
    await inbound({ sentAt: null, createdAt: BEFORE });
    await expect(proof(SESSION_AT)).resolves.toBe('thread');
  });

  it('a Linq failure is unread, never no_thread', async () => {
    await inbound({});
    await expect(
      proof(SESSION_AT, async () => {
        throw new LinqSendError('not_configured', 0, false);
      }),
    ).resolves.toBe('unread');
  });

  it('any other error is not swallowed', async () => {
    await expect(
      proof(SESSION_AT, async () => {
        throw new TypeError('bug');
      }),
    ).rejects.toThrow('bug');
  });
});

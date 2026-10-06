import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintChannelSigninTokens } from '~/lib/auth/channel-signin';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { textFreshConnectorLink } from './fresh-link';

/**
 * A failed connect texts a new link for the provider the parent was already
 * opening. Gmail stays Gmail. The body does not tell them a phrase to type.
 */

const NOW = new Date('2026-09-17T15:00:00.000Z');
const PHONE = '+14165550143';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe('textFreshConnectorLink', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let transport: FakeTransport;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    transport = new FakeTransport();
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('texts a Gmail link when the Gmail connect failed, and leaves the old token spent', async () => {
    const [oldLink] = await mintChannelSigninTokens(db.database, {
      userId: parentUserId,
      count: 1,
      now: NOW,
    });
    if (!oldLink) throw new Error('expected a token');

    const outcome = await textFreshConnectorLink(
      db.database,
      { familyId, parentUserId, provider: 'gmail', now: NOW },
      {
        transport,
        threadMessage: async () => 'conversation-id',
      },
    );

    expect(outcome).toBe('sent');
    expect(transport.sent).toHaveLength(1);
    const body = transport.sent[0]?.body ?? '';
    expect(body).toContain('to=gmail');
    expect(body).toContain('unverified app');
    expect(body).not.toMatch(/connect my calendar/i);
    expect(body).not.toContain('to=gcal');
    const [spent] = await db.database
      .select({ consumedAt: schema.channelSigninTokens.consumedAt })
      .from(schema.channelSigninTokens)
      .where(eq(schema.channelSigninTokens.id, oldLink.tokenId));
    expect(spent?.consumedAt).not.toBeNull();
  });

  it('texts the link into their own 1:1 chat when their last message was in the family group', async () => {
    const GROUP = 'chat-family-group';
    const PERSONAL = 'chat-parent-direct';
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, familyId));
    for (const [chatId, at] of [
      [PERSONAL, new Date('2026-09-17T14:00:00.000Z')],
      [GROUP, new Date('2026-09-17T14:30:00.000Z')],
    ] as const) {
      await db.database.insert(schema.channelMessages).values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerMessageId: `in-${chatId}`,
        providerChatId: chatId,
        status: 'delivered',
        body: 'hi',
        sentAt: at,
        createdAt: at,
      });
    }
    const imessage: Array<{ chatId: string; body: string }> = [];

    const outcome = await textFreshConnectorLink(
      db.database,
      { familyId, parentUserId, provider: 'gcal', now: NOW },
      {
        transport,
        imessage: async (input) => {
          imessage.push(input);
          return { providerMessageId: 'out-1' };
        },
        threadMessage: async () => 'conversation-id',
      },
    );

    expect(outcome).toBe('sent');
    expect(imessage.map((send) => send.chatId)).toEqual([PERSONAL]);
    expect(imessage[0]?.body).toContain('to=gcal');
    expect(transport.sent).toEqual([]);
  });
});

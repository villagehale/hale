import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resolveFollowUpRecipient } from './sweep';

/**
 * THE THREAD A KEPT PROMISE IS ANSWERED IN, read off the production resolver against the
 * real DDL. A thread is returned only for a promise carried on iMessage, in a chat the
 * door last saw as 1:1. Anything it cannot vouch for is no thread, and today's routing.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

let seq = 0;

async function carrying(
  seeded: SeededFamily,
  over: Partial<typeof schema.channelMessages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      providerChatId: 'chat-one',
      providerMessageId: 'msg-carried',
      sentAt: new Date(),
      ...over,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('channel_messages insert returned no row');
  return row.id;
}

async function inbound(
  seeded: SeededFamily,
  chatId: string,
  inGroup: boolean | null,
  at: Date,
): Promise<void> {
  seq += 1;
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: chatId,
    providerMessageId: `msg-in-${seq}`,
    inGroup,
    createdAt: at,
  });
}

const EARLIER = new Date('2026-11-10T15:00:00.000Z');
const LATER = new Date('2026-11-10T16:00:00.000Z');

describe('resolveFollowUpRecipient: the thread', () => {
  it('an iMessage promise in a chat the door last saw as 1:1 is answered threaded in it', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(db.database, await carrying(seeded));
    expect(recipient?.thread).toEqual({ chatId: 'chat-one', messageId: 'msg-carried' });
  });

  it('a promise carried by SMS has no thread', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      await carrying(seeded, { channel: 'sms', providerChatId: null }),
    );
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it('a chat whose latest inbound came from a group has no thread', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    await inbound(seeded, 'chat-one', true, LATER);
    const recipient = await resolveFollowUpRecipient(db.database, await carrying(seeded));
    expect(recipient?.thread).toBeNull();
  });

  it('a chat the door never said was 1:1 has no thread (fail closed)', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', null, EARLIER);
    // A 1:1 inbound in ANOTHER chat says nothing about this one.
    await inbound(seeded, 'chat-elsewhere', false, LATER);
    const recipient = await resolveFollowUpRecipient(db.database, await carrying(seeded));
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it('an outbound row with no provider message id has no thread to reply under', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      await carrying(seeded, { providerMessageId: null }),
    );
    expect(recipient?.thread).toBeNull();
  });
});

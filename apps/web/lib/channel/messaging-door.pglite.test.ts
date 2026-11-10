import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resolveMessagingDoor } from './messaging-door';

/**
 * A private text to one parent may only enter a chat an inbound row recorded as
 * one-to-one (`direction = 'in' AND in_group = false`). A group chat, an outbound
 * send's chat, or a row whose group bit is unknown is never the door.
 */

const DIRECT = 'chat-parent-direct';
const MULTI_FAMILY_GROUP = 'chat-multi-family-group';

describe('resolveMessagingDoor', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let seq = 0;

  beforeEach(async () => {
    db = await createTestDb();
    ({ familyId, parentUserId } = await seedFamily(db.database));
  });

  afterEach(async () => {
    await db.close();
  });

  async function row(input: {
    direction: 'in' | 'out';
    chatId: string;
    inGroup: boolean | null;
    at: string;
  }): Promise<void> {
    seq += 1;
    const at = new Date(input.at);
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: input.direction,
      category: 'reply',
      providerMessageId: `msg-${seq}`,
      providerChatId: input.chatId,
      status: 'delivered',
      body: 'hi',
      inGroup: input.inGroup,
      sentAt: at,
      createdAt: at,
    });
  }

  it('a plain 1:1 iMessage parent gets that chat', async () => {
    await row({ direction: 'in', chatId: DIRECT, inGroup: false, at: '2026-11-01T10:00:00Z' });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({
      channel: 'imessage',
      chatId: DIRECT,
    });
  });

  it('is the older 1:1 chat when the newest inbound text was in a multi-family group', async () => {
    await row({ direction: 'in', chatId: DIRECT, inGroup: false, at: '2026-11-01T10:00:00Z' });
    await row({
      direction: 'in',
      chatId: MULTI_FAMILY_GROUP,
      inGroup: true,
      at: '2026-11-02T10:00:00Z',
    });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({
      channel: 'imessage',
      chatId: DIRECT,
    });
  });

  it('has no chat when the newest inbound text was in a group and no 1:1 chat exists', async () => {
    await row({
      direction: 'in',
      chatId: MULTI_FAMILY_GROUP,
      inGroup: true,
      at: '2026-11-02T10:00:00Z',
    });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({
      channel: 'imessage',
      chatId: null,
    });
  });

  it('never takes the chat of an outbound group send, even when it is the only chat on record', async () => {
    await row({
      direction: 'in',
      chatId: MULTI_FAMILY_GROUP,
      inGroup: true,
      at: '2026-11-02T10:00:00Z',
    });
    await row({
      direction: 'out',
      chatId: 'chat-outbound-group',
      inGroup: null,
      at: '2026-11-02T10:01:00Z',
    });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({
      channel: 'imessage',
      chatId: null,
    });
  });

  it('never takes a chat whose inbound row has an unknown group bit', async () => {
    await row({
      direction: 'in',
      chatId: 'chat-unknown',
      inGroup: null,
      at: '2026-11-02T10:00:00Z',
    });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({
      channel: 'imessage',
      chatId: null,
    });
  });

  it('stays on SMS when the newest inbound text was SMS, though an older 1:1 iMessage chat exists', async () => {
    await row({ direction: 'in', chatId: DIRECT, inGroup: false, at: '2026-11-01T10:00:00Z' });
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'msg-sms-in',
      status: 'delivered',
      body: 'hi',
      createdAt: new Date('2026-11-02T10:00:00Z'),
    });

    expect(await resolveMessagingDoor(db.database, parentUserId)).toEqual({ channel: 'sms' });
  });

  it('still never returns the excluded chat, even a recorded 1:1', async () => {
    await row({ direction: 'in', chatId: DIRECT, inGroup: false, at: '2026-11-02T10:00:00Z' });

    expect(
      await resolveMessagingDoor(db.database, parentUserId, { excludeChatId: DIRECT }),
    ).toEqual({ channel: 'imessage', chatId: null });
  });
});

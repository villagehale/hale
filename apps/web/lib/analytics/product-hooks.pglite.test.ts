import { type Database, schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from '~/lib/testing/clock';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resetPosthogClientsForTests } from './posthog-node';
import { decodeBatch, ours } from './posthog-wire.testkit';
import { messageEventProperties, noteMessage } from './product-hooks';
import { resetProductCaptureLogsForTests } from './product';

/**
 * VIL-722 · what one message event says about its chat: the transport (the service Linq
 * said carried it, not the pipe) and the chat kind (a 1:1, one household's group, or a
 * group of two or more households). Retention per channel in PostHog splits on both.
 */

const CHAT = 'chat-1to1';
const GROUP = 'chat-group';
const EARLIER = at('2026-11-18T15:00:00.000Z');
const LATER = at('2026-11-19T15:00:00.000Z');

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LATER);
  await db.exec('truncate table families, users cascade');
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPosthogClientsForTests();
  resetProductCaptureLogsForTests();
});

/** An inbound row as the Linq door writes it: the service rides beside the row. */
async function inbound(
  chatId: string,
  service: schema.LinqServiceValue | null,
  createdAt: Date,
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: chatId,
    providerService: service,
    createdAt,
  });
}

describe('messageEventProperties', () => {
  it('labels a 1:1 inbound with the service Linq said carried it', async () => {
    expect(
      await messageEventProperties({
        direction: 'in',
        familyId,
        channel: 'imessage',
        isGroup: false,
        chatId: CHAT,
        service: 'SMS',
        database: db.database,
        parentUserId,
      }),
    ).toEqual({
      channel: 'imessage',
      is_group: false,
      family_count: 1,
      chat_kind: 'one_to_one',
      transport: 'sms',
      media_type: 'none',
    });
  });

  it("labels a Linq send with the chat's newest named service, read from the parent's inbound", async () => {
    await inbound(CHAT, 'iMessage', EARLIER);
    await inbound(CHAT, 'SMS', LATER);
    await inbound(CHAT, null, LATER);
    await inbound('chat-elsewhere', 'RCS', LATER);
    const props = await messageEventProperties({
      direction: 'out',
      familyId,
      channel: 'imessage',
      chatId: CHAT,
      database: db.database,
      parentUserId,
    });
    expect(props.transport).toBe('sms');
  });

  it('says unknown when no inbound in the chat ever named a service, or there is nothing to read', async () => {
    await inbound(CHAT, null, LATER);
    const send = { direction: 'out' as const, familyId, channel: 'imessage', chatId: CHAT };
    expect(
      (await messageEventProperties({ ...send, database: db.database, parentUserId })).transport,
    ).toBe('unknown');
    expect((await messageEventProperties({ ...send, database: db.database })).transport).toBe(
      'unknown',
    );
    expect((await messageEventProperties(send)).transport).toBe('unknown');
  });

  it('labels a group one household or several by who is in it', async () => {
    const other = await seedFamily(db.database, 'Other Family');
    const group = {
      direction: 'in' as const,
      familyId,
      channel: 'imessage',
      isGroup: true,
      chatId: GROUP,
      service: 'iMessage' as const,
      database: db.database,
    };
    expect(await messageEventProperties(group)).toMatchObject({
      channel: 'group',
      is_group: true,
      chat_kind: 'family_group',
      transport: 'imessage',
    });

    await db.database.insert(schema.linqSharedGroupPeople).values([
      { chatId: GROUP, phoneE164Hash: 'hash-a', familyId, seatedAt: EARLIER },
      { chatId: GROUP, phoneE164Hash: 'hash-b', familyId: other.familyId, seatedAt: EARLIER },
    ]);
    expect(await messageEventProperties(group)).toMatchObject({
      chat_kind: 'multi_family_group',
    });
    // With no reader, a group takes the household default `family_count` already takes.
    expect(await messageEventProperties({ ...group, database: undefined })).toMatchObject({
      chat_kind: 'family_group',
      family_count: 1,
    });
  });
});

describe('noteMessage', () => {
  /** A handle that records any read and refuses it. */
  function watchedDatabase(): { database: Database; touched: string[] } {
    const touched: string[] = [];
    const database = new Proxy(
      {},
      {
        get(_target, key) {
          touched.push(String(key));
          throw new Error('read');
        },
      },
    ) as unknown as Database;
    return { database, touched };
  }

  it('reads nothing while product events are dark', async () => {
    vi.stubEnv('POSTHOG_PRODUCT_EVENTS_ENABLED', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { database, touched } = watchedDatabase();

    noteMessage({
      direction: 'out',
      familyId,
      channel: 'imessage',
      isGroup: true,
      chatId: GROUP,
      database,
      parentUserId,
    });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

    expect(touched).toEqual([]);
  });

  it('sends the transport and the chat kind, and no id, once product events are on', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    vi.stubEnv('POSTHOG_PRODUCT_EVENTS_ENABLED', 'true');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await inbound(CHAT, 'RCS', LATER);

    noteMessage({
      direction: 'out',
      familyId,
      channel: 'imessage',
      isGroup: false,
      chatId: CHAT,
      database: db.database,
      parentUserId,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const { text, events } = decodeBatch(fetchMock.mock.calls[0]?.[1]);
    expect(events[0]?.event).toBe('message_outbound');
    expect(ours(events[0]?.properties ?? {})).toMatchObject({
      channel: 'imessage',
      is_group: false,
      chat_kind: 'one_to_one',
      transport: 'rcs',
    });
    expect(text).not.toContain(familyId);
    expect(text).not.toContain(parentUserId);
    expect(text).not.toContain(CHAT);
  });
});

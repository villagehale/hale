import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { dbContactCardShareStore } from './contact-card-share';
import { maybeShareLinqContactCard } from './transport';

/**
 * The share is remembered in Postgres, not in the process. A second store over
 * the same database is the restart: it must not share again. Error 2012 must
 * not insert a row.
 */

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DAY = new Date('2026-10-01T15:00:00.000Z');
const LATER = new Date('2027-04-01T15:00:00.000Z');
const API_KEY = 'linq_test_key_not_a_secret';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(() => {
  vi.stubEnv('LINQ_API_KEY', API_KEY);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await testDb.exec('truncate table linq_contact_card_shares');
});

describe('linq contact card share is remembered per chat', () => {
  it('writes a row on the first success and a new store does not share again', async () => {
    const fetchMock = vi.fn(async () => Response.json(null, { status: 200 }));
    await maybeShareLinqContactCard({
      chatId: CHAT,
      fetch: fetchMock,
      now: DAY,
      store: dbContactCardShareStore(testDb.database),
    });
    await maybeShareLinqContactCard({
      chatId: CHAT,
      fetch: fetchMock,
      now: LATER,
      store: dbContactCardShareStore(testDb.database),
    });
    await maybeShareLinqContactCard({
      chatId: OTHER,
      fetch: fetchMock,
      now: LATER,
      store: dbContactCardShareStore(testDb.database),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await testDb.database
      .select()
      .from(schema.linqContactCardShares)
      .orderBy(schema.linqContactCardShares.chatId);
    expect(rows).toEqual([
      { chatId: CHAT, sharedAt: DAY },
      { chatId: OTHER, sharedAt: LATER },
    ]);
  });

  it('does not write a row when Linq returns 2012, so a later send can try', async () => {
    const refused = vi.fn(async () =>
      Response.json({ error: { status: 409, code: 2012, message: 'no card' } }, { status: 409 }),
    );
    const store = dbContactCardShareStore(testDb.database);
    await maybeShareLinqContactCard({ chatId: CHAT, fetch: refused, now: DAY, store });
    const rows = await testDb.database.select().from(schema.linqContactCardShares);
    expect(rows).toEqual([]);

    const accepted = vi.fn(async () => Response.json(null, { status: 200 }));
    await maybeShareLinqContactCard({ chatId: CHAT, fetch: accepted, now: LATER, store });
    expect(refused).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    const remembered = await testDb.database.select().from(schema.linqContactCardShares);
    expect(remembered).toEqual([{ chatId: CHAT, sharedAt: LATER }]);
  });
});

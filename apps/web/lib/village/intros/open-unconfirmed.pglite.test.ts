import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { INTRO_GROUP_TEMPLATE_KEY, introGroupUnconfirmedKey } from './group';
import { defaultIntroSweepDeps } from './run';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('the production marker for a group Linq may have opened', () => {
  it('is a failed row, never a sent one, and the next sweep reads it as taken', async () => {
    const family = await seedFamily(db.database);
    const deps = defaultIntroSweepDeps();
    const dedupeKey = introGroupUnconfirmedKey('11111111-1111-4111-8111-111111111111');
    expect(await deps.dedupeActive(db.database, dedupeKey)).toBe(false);

    await deps.recordOpenUnconfirmed(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      templateKey: INTRO_GROUP_TEMPLATE_KEY,
      dedupeKey,
      code: 'http_409',
    });

    expect(await deps.dedupeActive(db.database, dedupeKey)).toBe(true);
    const rows = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
        sentAt: schema.channelMessages.sentAt,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, dedupeKey));
    expect(rows).toEqual([
      {
        status: 'failed',
        errorCode: 'unconfirmed:http_409',
        sentAt: null,
        providerMessageId: null,
      },
    ]);
  });
});

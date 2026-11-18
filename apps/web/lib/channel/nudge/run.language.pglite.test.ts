import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { selectNudgeFamilies } from './run';

/**
 * VIL-690. The live-search language is the primary parent's stored language.
 * One Chinese text, and the old `users.locale` it used to overwrite, do not change it.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('selectNudgeFamilies', () => {
  it('searches in the stored language after one off-language turn', async () => {
    const seeded = await seedFamily(db.database, 'Nudge language');
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.database
      .update(schema.families)
      .set({ primaryLanguage: 'en', onboardingStage: 'sms_active', createdAt: aged })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database
      .update(schema.users)
      .set({ locale: 'zh', proactiveLanguage: 'fr', timezone: 'America/Toronto' })
      .where(eq(schema.users.id, seeded.parentUserId));
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: '今天中文',
    });

    const families = await selectNudgeFamilies(db.database, new Date());
    expect(families.find((row) => row.familyId === seeded.familyId)?.language).toBe('fr');
  });
});

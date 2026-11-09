import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { readNoticeLanguage } from './notice-language';

let db: TestDb;
const NOW = new Date('2026-10-28T20:00:00Z');

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function family(primary: string, locale: string) {
  const seeded = await seedFamily(db.database, 'Zhang');
  await db.database
    .update(schema.families)
    .set({ primaryLanguage: primary })
    .where(eq(schema.families.id, seeded.familyId));
  await db.database
    .update(schema.users)
    .set({ locale })
    .where(eq(schema.users.id, seeded.parentUserId));
  return seeded;
}

async function inbound(seeded: { familyId: string; parentUserId: string }, at: Date) {
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'sms',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    body: 'sounds good, thanks',
    createdAt: at,
  });
}

describe('readNoticeLanguage', () => {
  it('a zh-CN profile whose parent texts in English gets English', async () => {
    const seeded = await family('zh-CN', 'en');
    await inbound(seeded, new Date(NOW.getTime() - 3 * 86_400_000));
    expect(await readNoticeLanguage(db.database, { ...seeded, now: NOW })).toBe('en');
  });

  it('with no recent inbound text, the profile is the hint', async () => {
    const seeded = await family('zh-CN', 'en-CA');
    await inbound(seeded, new Date(NOW.getTime() - 200 * 86_400_000));
    expect(await readNoticeLanguage(db.database, { ...seeded, now: NOW })).toBe('zh-cn');
  });
});

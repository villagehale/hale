import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { observeParentLanguage, readParentLanguage } from './parent-language';

/**
 * The store behind the one proactive language. The tags here are what the inbound screen
 * returns; whether the screen reads them right is the inbound-lane eval's job (rule #8).
 */

let db: TestDb;
let database: Database;

beforeAll(async () => {
  db = await createTestDb();
  database = db.database;
});

afterAll(async () => {
  await db.close();
});

async function languageRows(familyId: string) {
  return database
    .select({
      actor: schema.auditLog.actor,
      before: schema.auditLog.before,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'parent_language_changed'),
      ),
    );
}

describe('observeParentLanguage and readParentLanguage', () => {
  it('one Chinese text leaves the language English; three in a row make it Chinese, with one audit row', async () => {
    const family = await seedFamily(database);
    expect(await readParentLanguage(database, family)).toBe('en');

    const one = await observeParentLanguage(database, { ...family, seen: 'zh', requested: null });
    expect(one).toEqual({ status: 'counting' });
    expect(await readParentLanguage(database, family)).toBe('en');
    expect(
      await observeParentLanguage(database, { ...family, seen: 'en', requested: null }),
    ).toEqual({
      status: 'kept',
    });
    expect(await readParentLanguage(database, family)).toBe('en');
    expect(await languageRows(family.familyId)).toEqual([]);

    for (const status of ['counting', 'counting']) {
      expect(
        await observeParentLanguage(database, { ...family, seen: 'zh', requested: null }),
      ).toEqual({ status });
    }
    expect(
      await observeParentLanguage(database, { ...family, seen: 'zh', requested: null }),
    ).toEqual({
      status: 'switched',
      why: 'sustained',
    });
    expect(await readParentLanguage(database, family)).toBe('zh');
    expect(await languageRows(family.familyId)).toEqual([
      {
        actor: family.parentUserId,
        before: { language: 'en' },
        after: { language: 'zh', why: 'sustained' },
      },
    ]);
  });

  it('an explicit ask switches on the one text, and the family language is the fallback until then', async () => {
    const family = await seedFamily(database);
    await database
      .update(schema.families)
      .set({ primaryLanguage: 'fr' })
      .where(eq(schema.families.id, family.familyId));
    expect(await readParentLanguage(database, family)).toBe('fr');

    expect(
      await observeParentLanguage(database, { ...family, seen: 'fr', requested: 'en' }),
    ).toEqual({
      status: 'switched',
      why: 'asked',
    });
    expect(await readParentLanguage(database, family)).toBe('en');
    expect(await languageRows(family.familyId)).toHaveLength(1);
  });

  it('names a missing parent and a failed write, and logs no tag', async () => {
    const family = await seedFamily(database);
    expect(
      await observeParentLanguage(database, {
        familyId: family.familyId,
        parentUserId: '22222222-2222-4222-8222-222222222222',
        seen: 'zh',
        requested: null,
      }),
    ).toEqual({ status: 'not_written', reason: 'user_missing' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      transaction() {
        throw new Error('connection refused');
      },
    } as unknown as Database;
    expect(await observeParentLanguage(broken, { ...family, seen: 'zh', requested: null })).toEqual(
      {
        status: 'not_written',
        reason: 'write_failed',
      },
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('zh');
    log.mockRestore();
  });

  it('migration 0212 applies a second time over itself', async () => {
    await expect(db.applyMigration('0212_parent_proactive_language.sql')).resolves.toBeUndefined();
    const result = await db.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'users' and column_name in
          ('proactive_language', 'language_streak_tag', 'language_streak_count')
        order by column_name`,
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'language_streak_count',
      'language_streak_tag',
      'proactive_language',
    ]);
  });
});

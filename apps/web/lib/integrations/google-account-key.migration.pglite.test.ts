import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';

const MIGRATION = '0203_integrations_google_account_key.sql';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function keyOf(id: string) {
  const [row] = await db.database
    .select({ key: schema.integrations.googleAccountKey })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, id));
  return row?.key;
}

describe('0203 integrations google account key', () => {
  it('is in the migration chain', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('backfills the key a row still carries in its metadata, and leaves every other row as it is', async () => {
    const family = await seedFamily(db.database);
    const insert = async (
      provider: 'gcal' | 'gmail' | 'gdrive',
      providerMetadata: Record<string, unknown>,
      googleAccountKey: string | null,
    ) => {
      const [row] = await db.database
        .insert(schema.integrations)
        .values({
          familyId: family.familyId,
          userId: family.parentUserId,
          provider,
          providerMetadata,
          googleAccountKey,
        })
        .returning({ id: schema.integrations.id });
      return row?.id as string;
    };
    const carried = await insert(
      'gmail',
      { googleAccountKey: 'key-in-metadata', historyId: '9' },
      null,
    );
    const overwritten = await insert('gcal', { syncToken: 'sync-1' }, null);
    const already = await insert('gdrive', { googleAccountKey: 'stale-copy' }, 'key-in-column');

    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();

    expect(await keyOf(carried)).toBe('key-in-metadata');
    // A key a sync already overwrote is gone: the row stays unknown (the userId fallback).
    expect(await keyOf(overwritten)).toBeNull();
    // The column is the source of truth once written; a metadata copy never replaces it.
    expect(await keyOf(already)).toBe('key-in-column');
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();
  });
});

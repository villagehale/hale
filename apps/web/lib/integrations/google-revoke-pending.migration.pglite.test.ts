import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';

const MIGRATION = '0201_integrations_google_revoke_pending.sql';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('0201 integrations google revoke pending', () => {
  it('is in the migration chain', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('adds both columns nullable, so a row written without them still inserts', async () => {
    const family = await seedFamily(db.database);
    const [row] = await db.database
      .insert(schema.integrations)
      .values({ familyId: family.familyId, userId: family.parentUserId, provider: 'gcal' })
      .returning({
        id: schema.integrations.id,
        pending: schema.integrations.googleRevokePendingEncrypted,
        since: schema.integrations.googleRevokePendingSince,
      });
    expect(row).toMatchObject({ pending: null, since: null });

    const since = new Date('2026-11-04T15:00:00.000Z');
    await db.database
      .update(schema.integrations)
      .set({ googleRevokePendingEncrypted: 'ciphertext', googleRevokePendingSince: since })
      .where(eq(schema.integrations.id, row?.id as string));
    const [stored] = await db.database
      .select({
        pending: schema.integrations.googleRevokePendingEncrypted,
        since: schema.integrations.googleRevokePendingSince,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, row?.id as string));
    expect(stored).toEqual({ pending: 'ciphertext', since });
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();
  });
});

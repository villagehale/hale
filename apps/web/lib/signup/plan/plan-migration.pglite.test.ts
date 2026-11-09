import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDb,
  createTestDb,
  migrationFiles,
  seedChild,
  seedFamily,
} from '~/lib/testing/pglite';

const MIGRATION = migrationFiles().find((file) => file.endsWith('_authorized_signup_plan.sql'));

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function insertOffer(status: string) {
  const family = await seedFamily(db.database);
  const childId = await seedChild(db.database, family.familyId, 'Ada', 40);
  await db.exec(
    `insert into authorized_signup_offers (family_id, child_id, parent_user_id, activity_key, registration_url, sessions, status)
     values ('${family.familyId}', '${childId}', '${family.parentUserId}', 'swim', 'https://register.example-rec.test/x', '[]', '${status}')`,
  );
}

describe('authorized signup plan migration', () => {
  it('is in the migration chain', () => {
    expect(MIGRATION).toBeDefined();
  });

  it('survives a second pass and keeps the loosened status list', async () => {
    await db.applyMigration(MIGRATION as string);
    await db.applyMigration(MIGRATION as string);
    await expect(insertOffer('planned')).resolves.toBeUndefined();
    // Positive control: the CHECK is still there after the replay.
    await expect(insertOffer('bogus')).rejects.toThrow(/authorized_signup_offers_status_chk/);
  });
});

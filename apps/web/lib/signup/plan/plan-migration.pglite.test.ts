import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDb,
  createTestDb,
  migrationFiles,
  seedChild,
  seedFamily,
} from '~/lib/testing/pglite';

const MIGRATION = migrationFiles().find((file) => file.endsWith('_authorized_signup_plan.sql'));
const RESUME_MIGRATION = migrationFiles().find((file) =>
  file.endsWith('_authorized_signup_plan_resume.sql'),
);

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
    `insert into authorized_signup_offers (family_id, child_id, parent_user_id, activity_key, registration_url, provider_host, sessions, status)
     values ('${family.familyId}', '${childId}', '${family.parentUserId}', 'swim', 'https://register.example-rec.test/x', 'register.example-rec.test', '[]', '${status}')`,
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

describe('authorized signup plan resume migration', () => {
  it('survives a second pass and holds a resume token, a lease and a take-back', async () => {
    expect(RESUME_MIGRATION).toBeDefined();
    await db.applyMigration(RESUME_MIGRATION as string);
    await db.applyMigration(RESUME_MIGRATION as string);
    await insertOffer('submitting');
    await db.exec(
      `update authorized_signup_offers set plan_resume = '{"phase":"signup","runId":"run-1","sessionId":null,"browserId":null}'::jsonb, plan_lease_until = now(), plan_cancel_requested_at = now() where status = 'submitting'`,
    );
    const read = (await db.exec(
      `select plan_resume->>'runId' as run_id, plan_lease_until is not null as leased, plan_cancel_requested_at is not null as taken_back from authorized_signup_offers where status = 'submitting'`,
    )) as { rows: unknown[] }[];
    expect(read[0]?.rows).toEqual([{ run_id: 'run-1', leased: true, taken_back: true }]);
  });
});

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
const LAST_ASKED_MIGRATION = migrationFiles().find((file) =>
  file.endsWith('_authorized_signup_last_asked.sql'),
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

describe('authorized signup last-asked migration', () => {
  it('survives a second pass and holds when Hale last asked, null until it does', async () => {
    expect(LAST_ASKED_MIGRATION).toBeDefined();
    await db.applyMigration(LAST_ASKED_MIGRATION as string);
    await db.applyMigration(LAST_ASKED_MIGRATION as string);
    await insertOffer('pending');
    const before = (await db.exec(
      'select count(*)::int as unasked from authorized_signup_offers where last_asked_at is null',
    )) as { rows: { unasked: number }[] }[];
    expect(before[0]?.rows[0]?.unasked).toBeGreaterThan(0);
    await db.exec(
      `update authorized_signup_offers set last_asked_at = '2026-11-30T20:00:00Z' where last_asked_at is null`,
    );
    const after = (await db.exec(
      `select (count(*) filter (where last_asked_at is null))::int as unasked, max(last_asked_at) = '2026-11-30T20:00:00Z'::timestamptz as stamped from authorized_signup_offers`,
    )) as { rows: { unasked: number; stamped: boolean }[] }[];
    expect(after[0]?.rows).toEqual([{ unasked: 0, stamped: true }]);
  });
});

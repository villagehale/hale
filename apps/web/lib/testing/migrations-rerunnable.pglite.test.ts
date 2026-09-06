import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles } from './pglite';

/**
 * The faithful half of packages/db/scripts/migration-rerunnable.test.mjs.
 *
 * That gate is a static deny-list of statement shapes; this one re-runs the real files
 * against a real, already-migrated Postgres — which is exactly what the Deploy migrate
 * leg does to a migration prod received by hand. The static gate passed #609 while prod
 * still failed: a UNIQUE constraint creates an index RELATION, so Postgres raises
 * `duplicate_table` (42P07) for it, not the `duplicate_object` (42710) a foreign key or
 * CHECK raises — and a guard that catches only the latter re-throws the former. Only a
 * second pass on a real database can tell those apart.
 */

/** The last migration prod's ledger recorded before the hand-apply era (see the static
 * gate). Everything after it must survive being applied twice. */
const LAST_LEDGERED_FILE = '0097_pending_disambiguation.sql';

describe('migrations after the ledger watermark survive a second pass', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('re-applies every migration after 0097 on the already-migrated schema without throwing', async () => {
    const rerun = migrationFiles().filter((file) => file > LAST_LEDGERED_FILE);
    expect(rerun.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of rerun) {
      try {
        await db.applyMigration(file);
      } catch (err) {
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('positive control: a bare ADD CONSTRAINT on an existing UNIQUE really does raise on a second pass', async () => {
    await expect(
      db.exec(
        'ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_token_hash_unique" UNIQUE("token_hash")',
      ),
    ).rejects.toThrow(/already exists/);
  });
});

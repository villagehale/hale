import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from './pglite';

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
    db = await createTestDb('0171_channel_pending_asks.sql');
  });

  afterAll(async () => {
    await db.close();
  });

  it('re-applies every migration after 0097 on the already-migrated schema without throwing', async () => {
    const rerun = migrationFiles().filter((file) => file > LAST_LEDGERED_FILE && file < '0172_');
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

  it('catalog retirement preserves its final state when reapplied', async () => {
    await db.applyMigration('0172_activity_history_only.sql');
    await db.applyMigration('0172_activity_history_only.sql');
    const result = await db.client.query(
      "select to_regclass('village_candidates')::text as catalog, to_regclass('family_activity_history')::text as history, to_regclass('registration_windows')::text as registration",
    );
    expect(result.rows).toEqual([
      { catalog: null, history: 'family_activity_history', registration: 'registration_windows' },
    ]);
  });

  it('positive control: a bare ADD CONSTRAINT on an existing UNIQUE really does raise on a second pass', async () => {
    await expect(
      db.exec(
        'ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_token_hash_unique" UNIQUE("token_hash")',
      ),
    ).rejects.toThrow(/already exists/);
  });
});

/**
 * VIL-423 · the watch-storage migration, found by suffix so it survives renumbering at
 * merge. It drops and re-adds two constraints under their OLD names, which is what keeps
 * a deploy-leg replay of 0110/0111 from putting the tighter limits back.
 */
describe('0199 watch storage', () => {
  const WATCH_FILE = migrationFiles().find((f) =>
    f.endsWith('_registration_live_watch_storage.sql'),
  );
  const LONG_URL = `https://registration.example.org/course?ref=${'a'.repeat(2048 - 44)}`;
  const NOT_VALID = [
    'registration_sequences_course_check',
    'registration_sequences_course_url_length_check',
    'registration_sequences_date_review_check',
    'registration_sequences_target_check',
  ];
  const files = migrationFiles();
  const before = files[files.indexOf(WATCH_FILE as string) - 1];

  // Booted in hooks, never inside it(): a fresh pglite plus a replay through `before`
  // runs past the 5s test timeout on CI.
  let full: TestDb;
  let legacy: TestDb;

  beforeAll(async () => {
    full = await createTestDb();
    legacy = await createTestDb(before);
  });

  afterAll(async () => {
    await full.close();
    await legacy.close();
  });

  it('applies twice, and a replay of 0110 and 0111 afterwards does not tighten it back', async () => {
    expect(WATCH_FILE).toMatch(/^\d{4}_registration_live_watch_storage\.sql$/);
    const db = full;
    await db.applyMigration(WATCH_FILE as string);
    await db.applyMigration(WATCH_FILE as string);
    await db.applyMigration('0110_registration_sequence_prepared.sql');
    await db.applyMigration('0111_registration_sequence_course_url_length.sql');

    const { familyId, parentUserId } = await seedFamily(db.database, 'Replay Family');
    await expect(
      db.exec(`
          INSERT INTO registration_sequences (family_id, parent_user_id, course_url)
          VALUES ('${familyId}', '${parentUserId}', '${LONG_URL}')
        `),
    ).resolves.toBeDefined();

    // Positive control: the scoped pairing is the one in place, so a window-bound row
    // with a link and no date is still refused.
    const window = await db.client.query<{ id: string }>(`
        INSERT INTO registration_windows (municipality, program_domain, cycle_label, open_at, source_url, verified_at)
        VALUES ('sample_town', 'rec_program', 'Replay', '2026-08-11T10:30:00Z', 'https://example.test/window', '2026-09-01T00:00:00Z')
        RETURNING id
      `);
    await expect(
      db.exec(`
          INSERT INTO registration_sequences (family_id, window_id, parent_user_id, course_url)
          VALUES ('${familyId}', '${window.rows[0]?.id}', '${parentUserId}', 'https://registration.example.org/c/bound')
        `),
    ).rejects.toThrow(/registration_sequences_course_check/);

    const constraints = await db.client.query<{ conname: string; convalidated: boolean }>(
      'SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname',
      [NOT_VALID],
    );
    expect(constraints.rows).toEqual(
      NOT_VALID.map((conname) => ({ conname, convalidated: false })),
    );

    const indexes = await db.client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'registration_sequences' AND indexname = ANY($1) ORDER BY indexname",
      [['registration_sequences_check_idx', 'registration_sequences_live_url_uniq']],
    );
    expect(indexes.rows).toEqual([
      { indexname: 'registration_sequences_check_idx' },
      { indexname: 'registration_sequences_live_url_uniq' },
    ]);
  });

  it('applies over a legacy empty link, which VALIDATE would then refuse', async () => {
    expect(WATCH_FILE).toMatch(/^\d{4}_registration_live_watch_storage\.sql$/);
    const db = legacy;
    const { familyId, parentUserId } = await seedFamily(db.database, 'Legacy Family');
    const window = await db.client.query<{ id: string }>(`
        INSERT INTO registration_windows (municipality, program_domain, cycle_label, open_at, source_url, verified_at)
        VALUES ('sample_town', 'rec_program', 'Legacy', '2026-08-11T10:30:00Z', 'https://example.test/window', '2026-09-01T00:00:00Z')
        RETURNING id
      `);
    // Valid under 0110/0111: a non-NULL link (empty) paired with a date, length 0 <= 200.
    await db.exec(`
        INSERT INTO registration_sequences (family_id, window_id, parent_user_id, course_url, course_opens_at)
        VALUES ('${familyId}', '${window.rows[0]?.id}', '${parentUserId}', '', '2026-08-12T10:30:00Z')
      `);

    await expect(db.applyMigration(WATCH_FILE as string)).resolves.toBeUndefined();

    // Positive control, and the follow-up's recipe: the legacy row really does violate.
    await expect(
      db.exec(
        'ALTER TABLE registration_sequences VALIDATE CONSTRAINT registration_sequences_course_url_length_check',
      ),
    ).rejects.toThrow(/violate/);
  });
});

/** VIL-553 · the held-message table, found by suffix so it survives renumbering at merge. */
describe('opt_out_held_messages', () => {
  const HELD_FILE = migrationFiles().find((f) => f.endsWith('_opt_out_held_messages.sql'));
  const files = migrationFiles();
  const before = files[files.indexOf(HELD_FILE as string) - 1];
  let db: TestDb;

  // Booted in a hook, never inside it(): a replay through `before` runs past 5s on CI.
  beforeAll(async () => {
    db = await createTestDb(before);
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies twice, keeps its indexes, and has row-level security on', async () => {
    expect(HELD_FILE).toMatch(/^\d{4}_opt_out_held_messages\.sql$/);
    const absent = await db.client.query<{ reg: string | null }>(
      "SELECT to_regclass('public.opt_out_held_messages')::text AS reg",
    );
    expect(absent.rows).toEqual([{ reg: null }]);

    await db.applyMigration(HELD_FILE as string);
    await expect(db.applyMigration(HELD_FILE as string)).resolves.toBeUndefined();

    const table = await db.client.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.opt_out_held_messages')",
    );
    expect(table.rows).toEqual([{ relrowsecurity: true }]);
    const indexes = await db.client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'opt_out_held_messages' ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'opt_out_held_messages_next_read_idx',
      'opt_out_held_messages_phone_idx',
      'opt_out_held_messages_pkey',
    ]);
    const legacy = await db.client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'opt_out_read_holds' AND column_name = 'repointed_at'",
    );
    expect(legacy.rows).toEqual([{ column_name: 'repointed_at', is_nullable: 'YES' }]);
  });
});

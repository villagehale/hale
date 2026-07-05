#!/usr/bin/env node
// Read-only migration drift guard.
//
// Compares the drizzle journal (drizzle/meta/_journal.json) against what the
// target database has actually applied (drizzle.__drizzle_migrations) and, in
// the default gate mode, EXITS NON-ZERO with a loud listing of un-applied
// migrations when the DB is behind. This is the safety net that would have
// caught prod drifting 12 migrations behind for three weeks (incident
// 2026-06-14 — the Village cadence columns never existed in prod because
// migrations are never auto-applied). See docs/deploy/README.md.
//
// READ-ONLY: it runs exactly one SELECT (plus one more in --status mode). It
// NEVER creates the schema/table and NEVER applies a migration — applying is
// the deploy `migrate` leg's job, kept deliberate. If the migrations table is
// absent (a fresh, never-migrated DB) that is itself maximal drift.
//
// Modes:
//   (default)   gate    — exit 1 if behind, 0 if in sync. For CI/deploy.
//   --status            — human-readable applied-vs-pending list; exits 0
//                         unless behind (so `pnpm --filter @hale/db status`
//                         is a safe at-a-glance check that still fails loud).
//
// DB URL: reads DATABASE_DIRECT_URL (the non-pooled URL migrations use),
// falling back to DATABASE_URL — matching drizzle.config.ts. If NEITHER is
// set, it SKIPS with a notice and exits 0 (never hard-fail CI just because a
// secret is absent — same contract as the deploy legs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeDrift, migrationHash, readJournal } from './migration-drift.mjs';

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

const statusMode = process.argv.includes('--status');
const dbUrl = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;

if (!dbUrl) {
  console.info(
    '::notice::DATABASE_DIRECT_URL/DATABASE_URL absent — migration drift-check SKIPPED.',
  );
  process.exit(0);
}

/**
 * @param {import('postgres').Sql} sql
 * @returns {Promise<{ watermark: number | null, tableExists: boolean }>}
 *   `watermark` is the greatest applied `created_at` (null when no migration is
 *   recorded — table absent OR present-but-empty); `tableExists` disambiguates
 *   those two for an accurate message.
 */
async function readWatermark(sql) {
  const present = await sql`
    select 1
    from information_schema.tables
    where table_schema = ${MIGRATIONS_SCHEMA} and table_name = ${MIGRATIONS_TABLE}
    limit 1
  `;
  if (present.length === 0) return { watermark: null, tableExists: false };
  const rows = await sql`
    select max(created_at) as max
    from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
  `;
  const max = rows[0]?.max;
  return {
    watermark: max === null || max === undefined ? null : Number(max),
    tableExists: true,
  };
}

const sql = postgres(dbUrl, { max: 1, idle_timeout: 5, prepare: false });

try {
  const journal = readJournal(drizzleDir);
  const { watermark, tableExists } = await readWatermark(sql);
  const drift = computeDrift(journal, watermark);

  if (statusMode) {
    console.info(`Migration status — ${drift.appliedCount}/${drift.journalCount} applied.`);
    for (const entry of journal) {
      const applied = watermark !== null && entry.when <= watermark;
      const mark = applied ? 'applied ' : 'PENDING ';
      console.info(`  ${mark} ${entry.tag}  (${migrationHash(drizzleDir, entry.tag).slice(0, 12)})`);
    }
  }

  if (drift.behind) {
    console.error(
      `::error::Migration drift: database is BEHIND by ${drift.pending.length} migration(s).`,
    );
    console.error(
      `Applied ${drift.appliedCount}/${drift.journalCount}. Un-applied (apply via the deploy migrate leg / \`pnpm --filter @hale/db migrate\`):`,
    );
    for (const entry of drift.pending) console.error(`  - ${entry.tag}`);
    if (watermark === null) {
      console.error(
        tableExists
          ? 'The migrations table (drizzle.__drizzle_migrations) is empty — no migration was ever recorded (e.g. the DB was provisioned with `drizzle-kit push`, not `migrate`).'
          : 'The migrations table (drizzle.__drizzle_migrations) does not exist — this database was never migrated.',
      );
    }
    process.exitCode = 1;
  } else {
    console.info(
      `OK: database in sync — all ${drift.journalCount} migration(s) applied.`,
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}

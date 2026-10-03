#!/usr/bin/env node
// Read-only migration ledger gate.
//
// Compares the drizzle journal (drizzle/meta/_journal.json) to the hashes in
// drizzle.__drizzle_migrations and EXITS NON-ZERO when a journal file was not
// recorded. A watermark-only check reports "in sync" when a later created_at
// exists, which is how a reused journal slot and a skipped migration both stay
// quiet. This script never applies a migration.
//
// Modes:
//   (default)        gate — exit 1 if any journal hash is missing
//   --status         applied / exempt / pending list; still exits 1 if behind
//   --require-url    missing DATABASE_DIRECT_URL and DATABASE_URL is exit 1
//                    (the deploy and `pnpm db:check-migrations` contract).
//                    Without the flag, a missing URL skips with exit 0 so a
//                    local shell that has no database configured is not a crash.
//
// DB URL: DATABASE_DIRECT_URL, else DATABASE_URL. The value is never printed.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  computeLedgerDrift,
  describeLedgerDrift,
  readExemptionTags,
  readJournalWithHashes,
} from './migration-drift.mjs';

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(moduleDir, '..', 'drizzle');
const exemptionsPath = path.resolve(moduleDir, 'ledger-exemptions.json');

/**
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeDbError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('postgres://') || message.includes('postgresql://')) {
    return 'database connection failed (connection string redacted)';
  }
  return message;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function readDbUrl(env = process.env) {
  const direct = env.DATABASE_DIRECT_URL;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const pooled = env.DATABASE_URL;
  if (typeof pooled === 'string' && pooled.length > 0) return pooled;
  return undefined;
}

/**
 * @param {import('postgres').Sql} sql
 * @returns {Promise<{ hash: string, createdAt: number }[] | null>}
 */
async function readLedger(sql) {
  const present = await sql`
    select 1
    from information_schema.tables
    where table_schema = ${MIGRATIONS_SCHEMA} and table_name = ${MIGRATIONS_TABLE}
    limit 1
  `;
  if (present.length === 0) return null;
  const rows = await sql`
    select hash, created_at
    from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
  `;
  return rows.map((row) => ({
    hash: String(row.hash),
    createdAt: Number(row.created_at),
  }));
}

/**
 * @param {{ tag: string, when: number, hash: string }} entry
 * @param {Set<string>} recorded
 * @param {Set<number>} recordedWhens
 * @param {Set<string>} exemptTags
 * @returns {string}
 */
function statusMark(entry, recorded, recordedWhens, exemptTags) {
  if (recorded.has(entry.hash)) return 'applied ';
  if (exemptTags.has(entry.tag) && recordedWhens.has(entry.when)) return 'exempt  ';
  return 'PENDING ';
}

/**
 * @param {{ requireUrl?: boolean, statusMode?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>}
 */
export async function runMigrationCheck(options = {}) {
  const requireUrl = options.requireUrl === true;
  const statusMode = options.statusMode === true;
  const dbUrl = readDbUrl(options.env ?? process.env);

  if (!dbUrl) {
    if (requireUrl) {
      console.error(
        '::error::DATABASE_DIRECT_URL is not set (DATABASE_URL is not set either). Refusing to treat the schema as current. Set DATABASE_DIRECT_URL to the Supabase direct (port 5432, non-pooled) URL — the same name the Deploy workflow and the hale-web production build use.',
      );
      return 1;
    }
    console.info(
      '::notice::DATABASE_DIRECT_URL/DATABASE_URL absent — migration drift-check SKIPPED.',
    );
    return 0;
  }

  const journal = readJournalWithHashes(drizzleDir);
  const exemptTags = readExemptionTags(exemptionsPath);
  const sql = postgres(dbUrl, {
    max: 1,
    idle_timeout: 5,
    prepare: false,
    connect_timeout: 10,
    connection: { statement_timeout: 30_000 },
  });

  try {
    const ledger = await readLedger(sql);
    const drift = computeLedgerDrift(journal, ledger, exemptTags);
    if (statusMode) {
      const recorded = new Set((ledger ?? []).map((row) => row.hash));
      const recordedWhens = new Set((ledger ?? []).map((row) => row.createdAt));
      console.info(
        `Migration status — ${drift.appliedCount} hash(es) recorded, ${drift.exempted.length} exempt, ${drift.pending.length} pending, ${drift.journalCount} in the journal.`,
      );
      for (const entry of journal) {
        const mark = statusMark(entry, recorded, recordedWhens, exemptTags);
        console.info(`  ${mark} ${entry.tag}  (${entry.hash.slice(0, 12)})`);
      }
    }
    const report = describeLedgerDrift(drift);
    for (const line of report.lines) {
      if (report.ok) console.info(line);
      else console.error(line);
    }
    if (!report.ok && ledger === null) {
      console.error(
        'The migrations table (drizzle.__drizzle_migrations) does not exist — this database was never migrated.',
      );
    } else if (!report.ok && ledger?.length === 0) {
      console.error(
        'The migrations table (drizzle.__drizzle_migrations) is empty — no migration was ever recorded.',
      );
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    console.error(`::error::Migration check failed: ${sanitizeDbError(err)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (invokedDirectly()) {
  const code = await runMigrationCheck({
    requireUrl: process.argv.includes('--require-url'),
    statusMode: process.argv.includes('--status'),
  });
  process.exit(code);
}

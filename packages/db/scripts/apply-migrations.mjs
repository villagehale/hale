#!/usr/bin/env node
// Apply journal migrations, then fail if any journal hash is still missing.
//
// Holds a session advisory lock for the whole apply+check so the Vercel
// production build and the Deploy workflow cannot interleave DDL. The lock is
// the pair (841, 330) — fixed, not derived from a secret.
//
// Uses drizzle-orm's migrator (the same apply rule as `drizzle-kit migrate`).
// It does not need the compiled schema. A missing DATABASE_DIRECT_URL (and
// DATABASE_URL) exits 1 without connecting. The URL is never printed.
//
// drizzle migrate exits successfully when it skips a file whose `when` is
// already <= max(created_at). The hash check after it is what fails that case.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { readDbUrl, runMigrationCheck, sanitizeDbError } from './check-migration-drift.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(moduleDir, '..', 'drizzle');

// Two-int advisory lock. Both deploy paths must use this same pair.
const LOCK_KEY_1 = 841;
const LOCK_KEY_2 = 330;

/**
 * @returns {Promise<number>} process exit code
 */
export async function applyPendingMigrations() {
  const dbUrl = readDbUrl();
  if (!dbUrl) {
    console.error(
      '::error::DATABASE_DIRECT_URL is not set (DATABASE_URL is not set either). Refusing to apply migrations. Set DATABASE_DIRECT_URL to the Supabase direct (port 5432, non-pooled) URL — the GitHub Actions secret and the hale-web Production env var use this name.',
    );
    return 1;
  }

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    connection: { statement_timeout: 600_000 },
  });
  let locked = false;
  try {
    console.info(`Waiting for migration lock (${LOCK_KEY_1}, ${LOCK_KEY_2}).`);
    await sql.unsafe(`select pg_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2})`);
    locked = true;
    console.info('Applying drizzle migrations.');
    await migrate(drizzle(sql), { migrationsFolder: drizzleDir });
    const code = await runMigrationCheck({ requireUrl: true });
    if (code !== 0) {
      console.error('::error::Migrations were not recorded. The deployment must not proceed.');
    }
    return code;
  } catch (err) {
    console.error(`::error::Migration apply failed: ${sanitizeDbError(err)}`);
    return 1;
  } finally {
    if (locked) {
      try {
        await sql.unsafe(`select pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`);
      } catch (err) {
        console.error(`::error::Failed to release migration lock: ${sanitizeDbError(err)}`);
      }
    }
    await sql.end({ timeout: 5 });
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (invokedDirectly()) {
  const code = await applyPendingMigrations();
  process.exit(code);
}

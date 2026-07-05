// Pure, side-effect-free migration-drift logic + journal/hash helpers.
//
// Drizzle's apply rule (drizzle-orm pg-core dialect `migrate`): it reads the
// single row with the greatest `created_at` from `drizzle.__drizzle_migrations`
// and applies every journal entry whose `when` (stored as `created_at`) is
// strictly greater than that maximum, in journal order. So a journal entry is
// APPLIED iff `entry.when <= max(created_at)` in the DB. That single-watermark
// rule is exactly what we mirror here — no hash comparison, because drizzle
// itself never re-hashes to decide what to apply.
//
// Split out from the CLI so the comparison is unit-testable without a database.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ tag: string, when: number }} JournalEntry
 * @typedef {{ appliedCount: number, pending: JournalEntry[], journalCount: number, behind: boolean }} DriftResult
 */

/**
 * Read the drizzle journal into `{ tag, when }[]` in journal order.
 * @param {string} drizzleDir absolute path to the `drizzle/` folder
 * @returns {JournalEntry[]}
 */
export function readJournal(drizzleDir) {
  const journalPath = path.join(drizzleDir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  return journal.entries.map((e) => ({ tag: e.tag, when: e.when }));
}

/**
 * SHA-256 hex of a migration's raw SQL file — identical to how drizzle-orm
 * hashes it in `readMigrationFiles`. Only used for `status` display, never for
 * the drift verdict (see module header).
 * @param {string} drizzleDir
 * @param {string} tag
 * @returns {string}
 */
export function migrationHash(drizzleDir, tag) {
  const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Compare the journal against the DB watermark.
 *
 * @param {JournalEntry[]} journal ordered journal entries
 * @param {number | null} maxAppliedCreatedAt greatest `created_at` in
 *   `drizzle.__drizzle_migrations`, or `null` when the table/schema is absent
 *   (a fresh, never-migrated database — everything is pending).
 * @returns {DriftResult}
 */
export function computeDrift(journal, maxAppliedCreatedAt) {
  const watermark = maxAppliedCreatedAt;
  const pending =
    watermark === null ? [...journal] : journal.filter((e) => e.when > watermark);
  return {
    journalCount: journal.length,
    appliedCount: journal.length - pending.length,
    pending,
    behind: pending.length > 0,
  };
}

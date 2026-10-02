// Pure, side-effect-free migration-drift logic + journal/hash helpers.
//
// Drizzle's apply rule (drizzle-orm `migrate`): it reads the single row with the
// greatest `created_at` from `drizzle.__drizzle_migrations` and applies every
// journal entry whose `when` (stored as `created_at`) is strictly greater than
// that maximum, in journal order. `computeDrift` mirrors that watermark. It is
// NOT the deploy gate. A watermark treats a journal file as applied whenever
// some later (or same) `created_at` is recorded, even when this file's sha256
// was never inserted — the 0144 slot was reused after a revert, and an in-place
// edit of an already-applied file changes the hash drizzle stored. The gate is
// `computeLedgerDrift`: a journal entry is applied only when its current file
// hash is in the ledger. Historical mismatches are listed in
// ledger-exemptions.json; every other missing hash fails the deploy.
//
// Split out from the CLI so the comparison is unit-testable without a database.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ tag: string, when: number }} JournalEntry
 * @typedef {{ tag: string, when: number, hash: string }} HashedJournalEntry
 * @typedef {{ hash: string, createdAt: number }} LedgerRow
 * @typedef {{ appliedCount: number, pending: JournalEntry[], journalCount: number, behind: boolean }} DriftResult
 * @typedef {{
 *   appliedCount: number,
 *   pending: HashedJournalEntry[],
 *   exempted: HashedJournalEntry[],
 *   skippedByWatermark: HashedJournalEntry[],
 *   journalCount: number,
 *   behind: boolean,
 *   watermark: number | null,
 *   unknownExemptions: string[],
 * }} LedgerDriftResult
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
 * Journal entries plus the sha256 drizzle stores in `__drizzle_migrations.hash`.
 * @param {string} drizzleDir
 * @returns {HashedJournalEntry[]}
 */
export function readJournalWithHashes(drizzleDir) {
  return readJournal(drizzleDir).map((entry) => ({
    ...entry,
    hash: migrationHash(drizzleDir, entry.tag),
  }));
}

/**
 * Historical journal files whose current bytes are not the hash drizzle recorded.
 * @param {string} exemptionsPath
 * @returns {Set<string>}
 */
export function readExemptionTags(exemptionsPath) {
  const parsed = JSON.parse(fs.readFileSync(exemptionsPath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`${exemptionsPath}: expected { entries: [...] }`);
  }
  const tags = new Set();
  for (const entry of parsed.entries) {
    const tag = entry?.tag;
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (typeof tag !== 'string' || tag.length === 0 || reason.length === 0) {
      throw new Error(`${exemptionsPath}: every entry needs a tag and a reason`);
    }
    if (tags.has(tag)) throw new Error(`${exemptionsPath}: duplicate tag ${tag}`);
    tags.add(tag);
  }
  return tags;
}

/**
 * SHA-256 hex of a migration's raw SQL file — identical to how drizzle-orm
 * hashes it in `readMigrationFiles`. The deploy gate compares this to
 * `__drizzle_migrations.hash`.
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
  const pending = watermark === null ? [...journal] : journal.filter((e) => e.when > watermark);
  return {
    journalCount: journal.length,
    appliedCount: journal.length - pending.length,
    pending,
    behind: pending.length > 0,
  };
}

/**
 * Compare journal file hashes to `drizzle.__drizzle_migrations`.
 *
 * `ledger === null` (or empty) means nothing was recorded. Exemptions do not
 * apply: a fresh database is fully pending.
 * An exemption covers only a tag whose `when` is already a `created_at` in the
 * ledger while the current file hash is not — an in-place edit, or a reverted
 * migration that reused the slot. A missing hash whose `when` was never
 * recorded is pending even if the tag is exempt, and even if a later row has
 * already moved the watermark past it (`drizzle migrate` will not apply it).
 *
 * @param {HashedJournalEntry[]} journal
 * @param {LedgerRow[] | null} ledger
 * @param {Set<string>} exemptTags
 * @returns {LedgerDriftResult}
 */
export function computeLedgerDrift(journal, ledger, exemptTags) {
  const watermark =
    ledger && ledger.length > 0 ? Math.max(...ledger.map((row) => Number(row.createdAt))) : null;
  if (!ledger || ledger.length === 0) {
    return {
      journalCount: journal.length,
      appliedCount: 0,
      pending: [...journal],
      exempted: [],
      skippedByWatermark: [],
      behind: journal.length > 0,
      watermark,
      unknownExemptions: [],
    };
  }
  const hashes = new Set(ledger.map((row) => row.hash));
  const recordedWhens = new Set(ledger.map((row) => Number(row.createdAt)));
  /** @type {HashedJournalEntry[]} */
  const pending = [];
  /** @type {HashedJournalEntry[]} */
  const exempted = [];
  let appliedCount = 0;
  for (const entry of journal) {
    if (hashes.has(entry.hash)) {
      appliedCount += 1;
      continue;
    }
    if (exemptTags.has(entry.tag) && recordedWhens.has(entry.when)) {
      exempted.push(entry);
      continue;
    }
    pending.push(entry);
  }
  const unknownExemptions = [...exemptTags].filter(
    (tag) => !journal.some((entry) => entry.tag === tag),
  );
  return {
    journalCount: journal.length,
    appliedCount,
    pending,
    exempted,
    skippedByWatermark: pending.filter((entry) => entry.when <= watermark),
    behind: pending.length > 0 || unknownExemptions.length > 0,
    watermark,
    unknownExemptions,
  };
}

/**
 * Human-readable gate report. `ok` is false whenever the deploy must fail.
 * @param {LedgerDriftResult & { unknownExemptions?: string[] }} result
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function describeLedgerDrift(result) {
  const unknown = result.unknownExemptions ?? [];
  if (!result.behind && unknown.length === 0) {
    const exempt =
      result.exempted.length > 0
        ? ` ${result.exempted.length} historical file(s) are exempt from the hash match.`
        : '';
    return {
      ok: true,
      lines: [
        `OK: database in sync — ${result.appliedCount} migration hash(es) recorded.${exempt}`,
      ],
    };
  }
  /** @type {string[]} */
  const lines = [];
  if (unknown.length > 0) {
    lines.push(
      `::error::Ledger exemption list names tag(s) that are not in the journal: ${unknown.join(', ')}.`,
    );
  }
  if (result.pending.length > 0) {
    lines.push(
      `::error::Migration drift: ${result.pending.length} journal migration(s) are not recorded in drizzle.__drizzle_migrations.`,
    );
    lines.push(
      `Recorded ${result.appliedCount}/${result.journalCount}. Unapplied (refusing to ship code that depends on them):`,
    );
    for (const entry of result.pending) lines.push(`  - ${entry.tag}`);
  }
  if (result.skippedByWatermark.length > 0) {
    lines.push(
      'drizzle migrate will not apply the tags above whose journal `when` is already <= max(created_at): that slot was recorded for different SQL. Ship a new migration with a later `when` (see 0150_family_trips_attempt_columns). Do not insert a ledger row by hand.',
    );
  }
  return { ok: false, lines };
}

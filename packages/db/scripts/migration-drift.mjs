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
// ledger-exemptions.json. A missing hash is accepted only by an explicit rule:
// `when` already recorded, `superseded_by` a later file whose hash is recorded,
// or a schema proof the caller verified. Anything else fails the deploy.
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
 *   invalidSupersessions: string[],
 *   blockedBySuccessor: string[],
 *   unprovenSchema: string[],
 * }} LedgerDriftResult
 * @typedef {{
 *   tag: string,
 *   reason: string,
 *   supersededBy?: string,
 *   schema?: { table: string, column: string, index?: string },
 * }} Exemption
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
 * Documented ledger gaps. A missing hash is not a skip: each entry names the
 * proof the gate still requires (a recorded `when`, a later file's hash, or a
 * schema object the caller has verified).
 * @param {string} exemptionsPath
 * @returns {Exemption[]}
 */
export function readExemptions(exemptionsPath) {
  const parsed = JSON.parse(fs.readFileSync(exemptionsPath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`${exemptionsPath}: expected { entries: [...] }`);
  }
  /** @type {Exemption[]} */
  const entries = [];
  const tags = new Set();
  for (const entry of parsed.entries) {
    const tag = entry?.tag;
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (typeof tag !== 'string' || tag.length === 0 || reason.length === 0) {
      throw new Error(`${exemptionsPath}: every entry needs a tag and a reason`);
    }
    if (tags.has(tag)) throw new Error(`${exemptionsPath}: duplicate tag ${tag}`);
    tags.add(tag);
    const supersededBy =
      entry.supersededBy === undefined ? undefined : String(entry.supersededBy).trim();
    const schema = entry.schema;
    if (supersededBy !== undefined && supersededBy.length === 0) {
      throw new Error(`${exemptionsPath}: ${tag} superseded_by is empty`);
    }
    if (supersededBy === tag) {
      throw new Error(`${exemptionsPath}: ${tag} cannot supersede itself`);
    }
    if (schema !== undefined && supersededBy !== undefined) {
      throw new Error(`${exemptionsPath}: ${tag} cannot combine superseded_by and schema`);
    }
    if (schema !== undefined) {
      const table = typeof schema.table === 'string' ? schema.table.trim() : '';
      const column = typeof schema.column === 'string' ? schema.column.trim() : '';
      const index =
        schema.index === undefined
          ? undefined
          : typeof schema.index === 'string'
            ? schema.index.trim()
            : '';
      if (table.length === 0 || column.length === 0 || index === '') {
        throw new Error(
          `${exemptionsPath}: ${tag} schema needs a table, a column, and a real index name`,
        );
      }
      entries.push({
        tag,
        reason,
        schema: index === undefined ? { table, column } : { table, column, index },
      });
      continue;
    }
    entries.push(supersededBy === undefined ? { tag, reason } : { tag, reason, supersededBy });
  }
  return entries;
}

/**
 * Historical journal files whose current bytes are not the hash drizzle recorded.
 * @param {string} exemptionsPath
 * @returns {Set<string>}
 */
export function readExemptionTags(exemptionsPath) {
  return new Set(readExemptions(exemptionsPath).map((entry) => entry.tag));
}

/**
 * A `Set` of tags is the older when-recorded rule, used by unit tests. The
 * exemptions file passes full entries.
 * @param {Set<string> | Exemption[]} exemptions
 * @returns {Exemption[]}
 */
function exemptionList(exemptions) {
  if (exemptions instanceof Set) {
    return [...exemptions].map((tag) => ({ tag, reason: 'when recorded' }));
  }
  if (!Array.isArray(exemptions)) {
    throw new Error('exemptions must be a list or a set of tags');
  }
  return exemptions;
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
 *
 * A missing hash is accepted only by the rule on that tag:
 * - no `supersededBy` and no `schema`: the file's `when` is already a
 *   `created_at` (an in-place edit, or a reverted migration that reused the slot).
 * - `supersededBy`: that tag is a later journal entry and its current file hash
 *   is in the ledger. The old `when` does not have to be recorded. Until the
 *   later hash is present, the old file stays pending.
 * - `schema`: `schemaProof` contains the tag, meaning the caller queried the
 *   documented column (and index, when named) and found them. Without that
 *   proof the file stays pending.
 *
 * @param {HashedJournalEntry[]} journal
 * @param {LedgerRow[] | null} ledger
 * @param {Set<string> | Exemption[]} exemptions
 * @param {Set<string>} [schemaProof] tags whose schema rule was verified
 * @returns {LedgerDriftResult}
 */
export function computeLedgerDrift(journal, ledger, exemptions, schemaProof = new Set()) {
  const rules = exemptionList(exemptions);
  const proof = schemaProof instanceof Set ? schemaProof : new Set();
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
      invalidSupersessions: [],
      blockedBySuccessor: [],
      unprovenSchema: [],
    };
  }
  const hashes = new Set(ledger.map((row) => row.hash));
  const recordedWhens = new Set(ledger.map((row) => Number(row.createdAt)));
  const byTag = new Map(rules.map((rule) => [rule.tag, rule]));
  const journalByTag = new Map(journal.map((entry) => [entry.tag, entry]));
  /** @type {HashedJournalEntry[]} */
  const pending = [];
  /** @type {HashedJournalEntry[]} */
  const exempted = [];
  /** @type {string[]} */
  const invalidSupersessions = [];
  /** @type {string[]} */
  const blockedBySuccessor = [];
  /** @type {string[]} */
  const unprovenSchema = [];
  let appliedCount = 0;
  for (const entry of journal) {
    if (hashes.has(entry.hash)) {
      appliedCount += 1;
      continue;
    }
    const rule = byTag.get(entry.tag);
    if (rule?.supersededBy) {
      const successor = journalByTag.get(rule.supersededBy);
      const later = successor !== undefined && successor.when > entry.when;
      if (!later) {
        invalidSupersessions.push(entry.tag);
        pending.push(entry);
        continue;
      }
      if (hashes.has(successor.hash)) {
        exempted.push(entry);
        continue;
      }
      blockedBySuccessor.push(entry.tag);
      pending.push(entry);
      continue;
    }
    if (rule?.schema) {
      if (proof.has(entry.tag)) {
        exempted.push(entry);
        continue;
      }
      unprovenSchema.push(entry.tag);
      pending.push(entry);
      continue;
    }
    if (rule && recordedWhens.has(entry.when)) {
      exempted.push(entry);
      continue;
    }
    pending.push(entry);
  }
  const unknownExemptions = rules.map((rule) => rule.tag).filter((tag) => !journalByTag.has(tag));
  return {
    journalCount: journal.length,
    appliedCount,
    pending,
    exempted,
    skippedByWatermark: pending.filter((entry) => entry.when <= watermark),
    behind: pending.length > 0 || unknownExemptions.length > 0 || invalidSupersessions.length > 0,
    watermark,
    unknownExemptions,
    invalidSupersessions,
    blockedBySuccessor,
    unprovenSchema,
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
  if ((result.blockedBySuccessor ?? []).length > 0) {
    lines.push(
      `A superseded_by gap stays pending until that later migration's hash is in the ledger (${result.blockedBySuccessor.join(', ')}). Do not insert a ledger row by hand.`,
    );
  }
  if ((result.unprovenSchema ?? []).length > 0) {
    lines.push(
      `A schema exemption counts only when the documented column is present (${result.unprovenSchema.join(', ')}). It is not a blanket skip.`,
    );
  }
  if ((result.invalidSupersessions ?? []).length > 0) {
    lines.push(
      `::error::superseded_by must name a later journal migration for: ${result.invalidSupersessions.join(', ')}.`,
    );
  }
  return { ok: false, lines };
}

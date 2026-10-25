import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-337 — holds migration 0109's CHECK constraints against the TypeScript source lists.
 *
 * `last_state`, `pending_kind` and `released_reason` are plain `text` columns with three
 * closed vocabularies, and each one exists twice: once in TypeScript (the writers'
 * allowlist and the derived union the sweep switches on) and once in SQL (the CHECK,
 * which is what actually makes a bad value unwritable by anybody, including a future
 * backfill). SQL cannot import the TS array, so this test is the seam between them — and
 * for this table it is the ONLY gate that reads the .sql against the .ts at all.
 *
 * Drift here does not degrade safely. A release reason the CHECK rejects fails the
 * release write, which leaves the watch LIVE: a spot Hale believes it has stopped
 * watching, still being fetched, still able to text. So it is caught at build time.
 *
 * The pattern (and this directory) follows unmet-vocabulary-consistency.test.mjs: read
 * the committed SQL, parse what it declares, compare against the code that depends on it.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(scriptDir, '..', 'drizzle', '0109_watched_spots.sql');
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'watched-spots.ts');

/** The quoted string literals inside a named CHECK's first `IN ( … )` list. */
function checkedValues(sql, constraintName) {
  const constraint = new RegExp(`CONSTRAINT "${constraintName}"[\\s\\S]*?IN \\(([\\s\\S]*?)\\)`).exec(
    sql,
  );
  if (!constraint) throw new Error(`no IN-list found for constraint "${constraintName}"`);
  return [...constraint[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The string literals in an exported `const NAME = [ … ] as const;` array. */
function sourceValues(ts, constName) {
  const declaration = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(ts);
  if (!declaration) throw new Error(`no source array found for ${constName}`);
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('watched-spots vocabulary · SQL CHECK ↔ TypeScript source', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ts = fs.readFileSync(SCHEMA, 'utf8');

  it('the state CHECK allows exactly the states a read can leave behind', () => {
    expect(checkedValues(sql, 'watched_spots_state_check')).toEqual(
      sourceValues(ts, 'WATCHED_SPOT_STATES'),
    );
  });

  it('the pending CHECK allows exactly the observations the claim can hold', () => {
    expect(checkedValues(sql, 'watched_spots_pending_check')).toEqual(
      sourceValues(ts, 'WATCHED_SPOT_PENDING_KINDS'),
    );
  });

  it('the release CHECK allows exactly the endings the sweep can write', () => {
    expect(checkedValues(sql, 'watched_spots_release_check')).toEqual(
      sourceValues(ts, 'WATCHED_SPOT_RELEASE_REASONS'),
    );
  });

  /** The vocabulary is only a guarantee while the columns cannot hold anything outside
   * it — an unconstrained `text` column would make the three lists above comments. The
   * pairing halves matter just as much: a release with no reason, or a held observation
   * with no clock, is the half-state the sweep's own logic reads as a live watch. */
  it('the pairing halves are constrained too, not just the vocabularies', () => {
    expect(sql).toMatch(/\("pending_kind" IS NULL\) = \("pending_since" IS NULL\)/);
    expect(sql).toMatch(/\("released_at" IS NULL\) = \("released_reason" IS NULL\)/);
    expect(sql).toContain('CONSTRAINT "watched_spots_notify_check"');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Holds migration 0122's CHECK constraints against the TypeScript source lists.
 *
 * `subject_source`, `verdict`, `child_age_band` and `tags` are plain `text` columns with
 * four closed vocabularies, and each exists twice: once in TypeScript (what the capture
 * pass and the aggregate reader switch on) and once in SQL (the CHECK, which is what
 * makes a bad value unwritable by anybody, including a future backfill). SQL cannot
 * import the TS array, so this test is the seam between them.
 *
 * Drift here does not degrade safely. A `subject_source` the CHECK rejects fails the
 * write and loses a family's answer; a tag the CHECK accepts but the reader has never
 * heard of would be printed to another household. And the age band's absent member is
 * a privacy guarantee, not a tidiness rule: 'teenager' must stay unwritable (rule #1).
 *
 * The pattern (and this directory) follows watched-spots-vocabulary-consistency.test.mjs.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(scriptDir, '..', 'drizzle', '0122_activity_reviews.sql');
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'activity-reviews.ts');

/** The quoted string literals inside a named CHECK's LAST `IN ( … )` list — last, because
 * the age-band CHECK opens with an IS NULL clause before its list. */
function checkedValues(sql, constraintName) {
  const block = new RegExp(`CONSTRAINT "${constraintName}"[\\s\\S]*?IN \\(([^)]*)\\)`).exec(sql);
  if (!block) throw new Error(`no IN-list found for constraint "${constraintName}"`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The quoted string literals inside a named CHECK's `ARRAY[ … ]` allowlist. */
function checkedArrayValues(sql, constraintName) {
  const block = new RegExp(`CONSTRAINT "${constraintName}"[\\s\\S]*?ARRAY\\[([\\s\\S]*?)\\]`).exec(
    sql,
  );
  if (!block) throw new Error(`no ARRAY allowlist found for constraint "${constraintName}"`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The string literals in an exported `const NAME = [ … ] as const;` array. */
function sourceValues(ts, constName) {
  const declaration = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(
    ts,
  );
  if (!declaration) throw new Error(`no source array found for ${constName}`);
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('activity-reviews vocabulary · SQL CHECK ↔ TypeScript source', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ts = fs.readFileSync(SCHEMA, 'utf8');

  it('the subject CHECK allows exactly the two shared identities the resolver returns', () => {
    expect(checkedValues(sql, 'activity_reviews_subject_source_check')).toEqual(
      sourceValues(ts, 'REVIEW_SUBJECT_SOURCES'),
    );
  });

  it('the verdict CHECK allows exactly the verdicts the extractor can produce', () => {
    expect(checkedValues(sql, 'activity_reviews_verdict_check')).toEqual(
      sourceValues(ts, 'ACTIVITY_VERDICTS'),
    );
  });

  it('the tag CHECK allows exactly the eight tags, and no more than three of them', () => {
    expect(checkedArrayValues(sql, 'activity_reviews_tags_check')).toEqual(
      sourceValues(ts, 'ACTIVITY_REVIEW_TAGS'),
    );
    expect(sql).toMatch(/coalesce\(array_length\("tags",1\),0\) <= 3/);
  });

  /** The one vocabulary whose ABSENT member is the guarantee: a 13+ child's activity must
   * be unreviewable by anybody, including a future backfill (rule #1). */
  it("the age-band CHECK allows four stages and can never hold 'teenager'", () => {
    const allowed = checkedValues(sql, 'activity_reviews_age_band_check');
    expect(allowed).toEqual(sourceValues(ts, 'ACTIVITY_REVIEW_AGE_BANDS'));
    expect(allowed).not.toContain('teenager');
  });

  /** The k>=3 threshold is only a threshold while count(*) IS count(distinct family_id).
   * Without this index a household that answered twice would be two families. */
  it('keeps one row per family per subject, which is what makes count(*) the k', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "activity_reviews_family_subject_uniq"[\s\S]*?\("family_id","subject_source","subject_ref"\)/,
    );
  });
});

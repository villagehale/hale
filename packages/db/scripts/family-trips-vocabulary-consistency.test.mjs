import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * v5 travel — holds migration 0125's CHECK constraints against the TypeScript source lists.
 *
 * `child_evidence` and `closed_reason` are plain `text` columns with two closed
 * vocabularies, and each one exists twice: once in TypeScript (what the detect pass and
 * the send sweep write) and once in SQL (the CHECK, which is what actually makes a bad
 * value unwritable by anybody, including a future backfill). SQL cannot import the TS
 * array, so this test is the seam between them — and for this table it is the ONLY gate
 * that reads the .sql against the .ts at all.
 *
 * Drift here does not degrade safely in either direction. A closed reason the CHECK
 * rejects fails the close, which leaves the trip OPEN: a trip Hale believes it has
 * finished with, re-selected every hour, able to text again. And a child-evidence value
 * the CHECK accepts but the code never writes is the one thing this table's design
 * forbids — see the 'none' assertion below.
 *
 * The pattern (and this directory) follows watched-spots-vocabulary-consistency.test.mjs.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(scriptDir, '..', 'drizzle', '0125_family_trips.sql');
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'family-trips.ts');

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

describe('family-trips vocabulary · SQL CHECK ↔ TypeScript source', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ts = fs.readFileSync(SCHEMA, 'utf8');

  it('the child-evidence CHECK allows exactly the evidence a detection can write', () => {
    expect(checkedValues(sql, 'family_trips_child_evidence_check')).toEqual(
      sourceValues(ts, 'CHILD_EVIDENCE'),
    );
  });

  it('the closed-reason CHECK allows exactly the endings the sweep can write', () => {
    expect(checkedValues(sql, 'family_trips_closed_reason_check')).toEqual(
      sourceValues(ts, 'TRIP_CLOSED_REASONS'),
    );
  });

  /**
   * THE ONE VALUE THAT MUST NOT EXIST.
   *
   * A booking whose own text gives no sign the children are on it writes NO ROW: the
   * outcome is `no_child_evidence`, counted at detection, with an enum-only audit row and
   * nothing stored. Making 'none' writable would put a parent's destination and travel
   * dates in a table for a trip Hale had already decided never to mention — a stored fact
   * with no purpose it could name (PIPEDA), permanently resident in the due index, and the
   * single row a requester-scoped rights export would hand to a co-parent.
   *
   * An absence assertion on its own fails open, so the two live values are asserted
   * present in the same `it`: a CHECK list this test could not parse at all would
   * otherwise pass.
   */
  it("'none' is absent from the child-evidence vocabulary, in BOTH the SQL and the TS", () => {
    const fromSql = checkedValues(sql, 'family_trips_child_evidence_check');
    const fromTs = sourceValues(ts, 'CHILD_EVIDENCE');
    for (const [label, values] of [
      ['sql', fromSql],
      ['ts', fromTs],
    ]) {
      // The positive control, first: the list really did parse and really is the
      // vocabulary, so the refusal below is a claim about content rather than about an
      // empty array.
      expect(values, `${label} child evidence`).toEqual(['child_fare', 'named_traveller']);
      expect(values, `${label} must not make 'none' storable`).not.toContain('none');
    }
  });

  /** The vocabularies are only a guarantee while the pairing halves are constrained too:
   * a close with no reason, or a `sent` with no message behind it, is the half-state the
   * sweep's own logic reads as a live trip or as a text the parent never got. */
  it('the pairing halves are constrained too, not just the vocabularies', () => {
    expect(sql).toMatch(/\("closed_at" IS NULL\) = \("closed_reason" IS NULL\)/);
    expect(sql).toContain('CONSTRAINT "family_trips_brief_message_check"');
    // COALESCE, not the natural form. A CHECK that evaluates to NULL PASSES in Postgres,
    // so `("brief_channel_message_id" IS NOT NULL) = ("closed_reason" IN (...))` is
    // vacuously true on every open row and enforces nothing at all.
    expect(sql).toMatch(/COALESCE\("closed_reason", ''\) IN \('sent', 'merged'\)/);
    expect(sql).toMatch(/CHECK \("ends_on" >= "starts_on"\)/);
  });

  /** The columns that were deliberately never created. A redaction step can be removed;
   * a column that does not exist cannot be written to by a future maker who did not read
   * the table's doc comment. */
  it('has no column for the body, the confirmation number or the price', () => {
    for (const forbidden of [
      'raw_body',
      '"body"',
      '"subject"',
      '"snippet"',
      'confirmation',
      '"price"',
      'child_id',
    ]) {
      expect(sql, `family_trips must not carry ${forbidden}`).not.toContain(`\t"${forbidden}"`);
      expect(sql.includes(`\t${forbidden}`), `family_trips must not carry ${forbidden}`).toBe(
        false,
      );
    }
    // Positive control: the columns it DOES carry are there, so the absences above are
    // claims about a table this test really parsed.
    for (const present of ['"destination_city"', '"starts_on"', '"child_evidence"']) {
      expect(sql).toContain(`\t${present} `);
    }
  });
});

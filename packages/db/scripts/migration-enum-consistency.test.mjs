import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// Guards the class of bug behind 0055 (VIL-217): a migration referenced the enum type
// "family_event_source" as a column type but no migration ever CREATE TYPE-d it, so a
// fresh `drizzle-kit migrate` fails at deploy — yet the file↔journal + drift gates were
// both blind to it (the enum lived only in the Drizzle schema, never in SQL). This
// walks the migrations in journal order and asserts every enum type a migration
// REFERENCES has been CREATE TYPE-d by that migration or an earlier one.
//
// Built-in Postgres types (uuid, text, integer, timestamp …) are UNquoted in Drizzle's
// SQL, so a DOUBLE-QUOTED token used as a column type is always a user-defined enum —
// that's how a reference is told apart from a table/column/constraint name.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

/** Enum type names a migration DECLARES: `CREATE TYPE "public"."name" AS ENUM(...)`. */
function declaredEnums(sql) {
  return [...sql.matchAll(/CREATE TYPE "public"\."([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
}

/** Enum type names a migration REFERENCES as a column type: a quoted column name
 * followed on the same line by a quoted type, which Drizzle writes either bare
 * (`"source" "family_event_source"`) or schema-qualified (`"channel"
 * "public"."loop_channel"`) — the optional `"public".` prefix is skipped so the TYPE is
 * captured, not the schema. Also covers `ADD COLUMN "x" "enum"`. A foreign-key
 * `REFERENCES "public"."users"` never matches: the token before `"public"` there is the
 * bare word `REFERENCES`, not a quoted column. */
function referencedEnums(sql) {
  return [
    ...sql.matchAll(/"[a-z_][a-z0-9_]*"[ \t]+(?:"public"\.)?"([a-z_][a-z0-9_]*)"/gi),
  ].map((m) => m[1]);
}

describe('migration enum ↔ declaration consistency', () => {
  it('every enum type a migration references is CREATE TYPE-d by it or an earlier migration', () => {
    const tags = readJournal(drizzleDir).map((e) => e.tag); // journal order (by idx)
    const declared = new Set();
    const violations = [];

    for (const tag of tags) {
      const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
      // Add THIS migration's declarations before checking its references — an enum may be
      // created and used in the same file (Drizzle emits CREATE TYPE first).
      for (const name of declaredEnums(sql)) declared.add(name);
      for (const name of referencedEnums(sql)) {
        if (!declared.has(name)) violations.push(`${tag} references enum "${name}" never CREATE TYPE-d`);
      }
    }

    expect(violations).toEqual([]);
  });
});

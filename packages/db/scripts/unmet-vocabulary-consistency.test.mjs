import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-273 — holds migration 0080's CHECK constraints against the TypeScript source list.
 *
 * `unmet_lane`/`unmet_category` are plain `text` columns with a closed vocabulary. That
 * vocabulary has to exist twice — once in TypeScript (the writer's allowlist and the
 * derived type) and once in SQL (the CHECK, which is what actually makes a bad value
 * unwritable by anybody, including a future backfill). SQL cannot import the TS array,
 * so this test is the seam between them.
 *
 * Drift degrades SAFELY in both directions — a TS value the CHECK rejects fails the
 * write, which `recordUnmetIntent` catches and reports as `not_recorded` — but "safely"
 * here means the demand signal quietly stops recording, which is precisely the kind of
 * silent nothing rule #11 exists to prevent. So it is caught at build time instead.
 *
 * The pattern (and this directory) follows migration-enum-consistency.test.mjs: read the
 * committed SQL, parse what it declares, compare against the code that depends on it.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  scriptDir,
  '..',
  'drizzle',
  '0080_channel_message_unmet_intent.sql',
);
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'channel-messages.ts');

/** The quoted string literals inside a named CHECK's `IN ( … )` list. */
function checkedValues(sql, constraintName) {
  const constraint = new RegExp(
    `ADD CONSTRAINT "${constraintName}"[\\s\\S]*?IN \\(([\\s\\S]*?)\\)`,
  ).exec(sql);
  if (!constraint) throw new Error(`no IN-list found for constraint "${constraintName}"`);
  return [...constraint[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The string literals in an exported `const NAME = [ … ] as const;` array. */
function sourceValues(ts, constName) {
  const declaration = new RegExp(
    `export const ${constName} = \\[([\\s\\S]*?)\\] as const;`,
  ).exec(ts);
  if (!declaration) throw new Error(`no source array found for ${constName}`);
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('unmet-intent vocabulary · SQL CHECK ↔ TypeScript source', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ts = fs.readFileSync(SCHEMA, 'utf8');

  it('the lane CHECK allows exactly the lanes the code can write', () => {
    expect(checkedValues(sql, 'channel_messages_unmet_lane_check')).toEqual(
      sourceValues(ts, 'UNMET_INTENT_LANES'),
    );
  });

  it('the category CHECK allows exactly the buckets the code can write', () => {
    expect(checkedValues(sql, 'channel_messages_unmet_category_check')).toEqual(
      sourceValues(ts, 'UNMET_INTENT_CATEGORIES'),
    );
  });

  /** The vocabulary is the rule-#1 guarantee, so the column must not be able to hold a
   * value from OUTSIDE it — an unconstrained `text` column would make the CHECK above a
   * comment. Both constraints must also tolerate NULL, which is the ordinary state of
   * every row the lane never touched. */
  it('both constraints admit NULL and nothing outside the list', () => {
    for (const name of [
      'channel_messages_unmet_lane_check',
      'channel_messages_unmet_category_check',
    ]) {
      expect(sql).toContain(`ADD CONSTRAINT "${name}"`);
    }
    expect(sql).toMatch(/CHECK \("unmet_lane" IS NULL OR "unmet_lane" IN \(/);
    expect(sql).toMatch(/CHECK \("unmet_category" IS NULL OR "unmet_category" IN \(/);
  });
});

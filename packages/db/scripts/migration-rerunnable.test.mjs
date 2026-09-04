import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// Guards the failure found on 2026-09-04: the Deploy migrate leg had been red for four
// consecutive main merges on `relation "join_invites_token_hash_unique" already exists`.
// Migrations 0098–0108 had been applied to prod BY HAND (the zero-downtime practice while
// the leg was dark), so drizzle's ledger still pointed at 0097 and `drizzle-kit migrate`
// re-ran 0098 — whose bare `ADD CONSTRAINT` is the one statement shape in those files
// that errors on a second run. Prod then silently missed 0099 for good.
//
// The invariant: every migration after the ledger's last honest watermark must be
// RE-RUNNABLE, so a hand-applied file and a deploy-applied file converge instead of
// colliding. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so constraints go through the
// `DO $$ … EXCEPTION WHEN duplicate_object …` guard 0103 established; everything else has a native
// IF [NOT] EXISTS form. A statement shape not listed below simply passes — this is a
// deny-list of the shapes that are KNOWN to throw on a second run, not a grammar.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

/** The last migration prod's ledger recorded before the hand-apply era. Everything
 * after it may be re-run by the deploy leg; everything up to it never will be. */
const LAST_LEDGERED_TAG = '0097_pending_disambiguation';

/** Statement shapes that raise on a second run, with the re-runnable form they must take. */
const NOT_RERUNNABLE = [
  { shape: /^ALTER TABLE\b[^;]*\bADD CONSTRAINT\b/i, use: 'DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT …; EXCEPTION WHEN duplicate_object THEN null; END $$ (the 0103 shape)' },
  { shape: /^CREATE TABLE (?!IF NOT EXISTS)/i, use: 'CREATE TABLE IF NOT EXISTS' },
  { shape: /^CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/i, use: 'CREATE [UNIQUE] INDEX IF NOT EXISTS' },
  { shape: /^ALTER TABLE\b[^;]*\bADD COLUMN (?!IF NOT EXISTS)/i, use: 'ADD COLUMN IF NOT EXISTS' },
  { shape: /^ALTER TYPE\b[^;]*\bADD VALUE (?!IF NOT EXISTS)/i, use: 'ADD VALUE IF NOT EXISTS' },
  { shape: /^CREATE TYPE\b/i, use: 'DO $$ BEGIN CREATE TYPE …; EXCEPTION WHEN duplicate_object THEN null; END $$' },
  { shape: /^DROP (?:TABLE|INDEX|TYPE) (?!IF EXISTS)/i, use: 'DROP … IF EXISTS' },
];

/** Split on drizzle's breakpoint marker, then strip SQL comments so a shape quoted in
 * prose (this file's own header, say) never counts as a statement. */
function statements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/** Inside a DO block a bare ADD CONSTRAINT is the guarded form, not the raw one. */
function isGuarded(statement) {
  return /^DO \$\$/i.test(statement);
}

describe('migrations after the ledger watermark are re-runnable', () => {
  it('no statement in 0098+ raises on a second run', () => {
    const journal = readJournal(drizzleDir);
    const watermark = journal.findIndex((entry) => entry.tag === LAST_LEDGERED_TAG);
    expect(watermark).toBeGreaterThan(-1);

    const offenders = [];
    for (const { tag } of journal.slice(watermark + 1)) {
      const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
      for (const statement of statements(sql)) {
        if (isGuarded(statement)) continue;
        for (const { shape, use } of NOT_RERUNNABLE) {
          if (shape.test(statement)) {
            offenders.push(`${tag}: ${statement.slice(0, 90)}… → use ${use}`);
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('positive control: the deny-list recognises the exact shape that broke the deploy leg', () => {
    const bare = 'ALTER TABLE "join_invites" ADD CONSTRAINT "join_invites_token_hash_unique" UNIQUE("token_hash")';
    expect(NOT_RERUNNABLE.some(({ shape }) => shape.test(bare))).toBe(true);
    expect(isGuarded(`DO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN ${bare}; END IF; END $$`)).toBe(true);
  });
});

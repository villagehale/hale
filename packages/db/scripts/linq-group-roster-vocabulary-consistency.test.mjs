import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

/**
 * Group onboarding v2 — holds migration 0158's CHECK constraints against the TypeScript
 * source lists, and pins the migration additive.
 *
 * The roster ledger's statuses and roles are plain `text` columns with closed
 * vocabularies that exist twice: in TypeScript (what roster.ts writes) and in SQL (the
 * CHECK). A status the CHECK rejects fails the roster write, which leaves the chat with no
 * roster, re-fetched on every inbound. The pattern follows
 * family-trips-vocabulary-consistency.test.mjs.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0158_linq_group_roster';
const MIGRATION = path.join(drizzleDir, `${TAG}.sql`);
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'linq-group-rosters.ts');

function checkedValues(sql, constraintName) {
  const constraint = new RegExp(
    `CONSTRAINT "${constraintName}"[\\s\\S]*?IN \\(([\\s\\S]*?)\\)`,
  ).exec(sql);
  if (!constraint) throw new Error(`no IN-list found for constraint "${constraintName}"`);
  return [...constraint[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

function sourceValues(ts, constName) {
  const declaration = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(
    ts,
  );
  if (!declaration) throw new Error(`no source array found for ${constName}`);
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

function statementsOf(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((stmt) => stmt.length > 0);
}

describe('0158_linq_group_roster vocabulary · SQL CHECK ↔ TypeScript source', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ts = fs.readFileSync(SCHEMA, 'utf8');

  it.each([
    ['linq_group_rosters_source_check', 'LINQ_GROUP_ROSTER_SOURCES'],
    ['linq_group_rosters_status_check', 'LINQ_GROUP_ROSTER_STATUSES'],
    ['linq_group_roster_members_proposed_role_check', 'LINQ_ROSTER_PROPOSED_ROLES'],
    ['linq_group_roster_members_status_check', 'LINQ_ROSTER_MEMBER_STATUSES'],
    ['linq_group_roster_members_confirmed_role_check', 'LINQ_ROSTER_CONFIRMED_ROLES'],
    ['linq_group_roster_members_connect_step_check', 'LINQ_ROSTER_CONNECT_STEPS'],
  ])('%s allows exactly %s', (constraint, source) => {
    expect(checkedValues(sql, constraint)).toEqual(sourceValues(ts, source));
  });

  it('never seats an extended/service role — the confirmed roles are the scoped ones', () => {
    expect(sourceValues(ts, 'LINQ_ROSTER_CONFIRMED_ROLES')).toEqual([
      'babysitter',
      'co_parent',
      'grandparent',
      'nanny',
    ]);
  });
});

describe('0158_linq_group_roster is additive and protected', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it('creates both tables idempotently with RLS on each', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "linq_group_rosters"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "linq_group_roster_members"');
    expect(sql).toContain('ALTER TABLE "linq_group_rosters" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "linq_group_roster_members" ENABLE ROW LEVEL SECURITY;');
  });

  it('keeps one roster per chat and one live roster row per phone per chat', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_rosters_chat_uniq" ON "linq_group_rosters" \("chat_id"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "linq_group_roster_members_live_uniq" ON "linq_group_roster_members" \("chat_id","phone_e164_hash"\) WHERE "status" NOT IN \('left', 'removed'\)/,
    );
  });

  it('touches nothing that exists already', () => {
    const statements = statementsOf(sql);
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      const upper = stmt.toUpperCase();
      for (const forbidden of ['DROP', 'RENAME', 'DELETE FROM', 'UPDATE ', 'ALTER TYPE']) {
        expect(upper).not.toContain(forbidden);
      }
      if (upper.startsWith('ALTER TABLE')) {
        expect(stmt).toMatch(
          /^ALTER TABLE "linq_group_roster(s|_members)" ENABLE ROW LEVEL SECURITY;$/,
        );
      }
    }
  });

  it('carries the Reversible block in its header', () => {
    expect(sql).toMatch(
      /Reversible:[\s\S]*DROP TABLE IF EXISTS linq_group_roster_members;[\s\S]*DROP TABLE IF EXISTS linq_group_rosters;/,
    );
  });

  it('is journaled last with a `when` above every open migration claim', () => {
    const journal = readJournal(drizzleDir);
    const tail = journal[journal.length - 1];
    expect(tail.tag).toBe(TAG);
    expect(tail.when).toBeGreaterThanOrEqual(1781469751000);
  });
});

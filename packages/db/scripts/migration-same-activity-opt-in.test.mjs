import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0147_same_activity_opt_ins';

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

describe('0147_same_activity_opt_ins', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('is journaled after 0146_linq_group_members', () => {
    const journal = readJournal(drizzleDir);
    const tags = journal.map((entry) => entry.tag);
    const entry = journal.find((row) => row.tag === TAG);
    expect(tags.indexOf('0146_linq_group_members')).toBe(
      tags.indexOf('0145_optional_ask_ledger') + 1,
    );
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0146_linq_group_members') + 1);
    expect(tags.filter((tag) => tag.startsWith('0145_'))).toEqual(['0145_optional_ask_ledger']);
    expect(tags.filter((tag) => tag.startsWith('0146_'))).toEqual(['0146_linq_group_members']);
    expect(tags.filter((tag) => tag.startsWith('0147_'))).toEqual([TAG]);
    expect(entry?.when).toBe(1781469641000);
  });

  it('stores a household opt-in and not another household, a child, or a place', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "same_activity_opt_ins"');
    for (const column of [
      '"family_id" uuid NOT NULL',
      '"parent_user_id" uuid NOT NULL',
      '"activity_key" text NOT NULL',
      '"kind" text NOT NULL',
      '"message_id" text NOT NULL',
      '"created_at" timestamp with time zone DEFAULT now() NOT NULL',
      '"revoked_at" timestamp with time zone',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("'meet'");
    expect(sql).toContain("'join_group'");
    for (const absent of ['child', 'location', 'display_name', 'email', 'body']) {
      expect(sql.toLowerCase()).not.toContain(`"${absent}"`);
    }
  });

  it('enables RLS, keeps one live yes, and does not drop or delete', () => {
    expect(sql).toContain('ALTER TABLE "same_activity_opt_ins" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('WHERE "revoked_at" IS NULL');
    const statements = statementsOf(sql);
    for (const stmt of statements) {
      const upper = stmt.toUpperCase();
      expect(upper).not.toMatch(/^\s*DROP\b/);
      expect(upper).not.toMatch(/^\s*DELETE\b/);
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DELETE FROM');
    }
  });
});

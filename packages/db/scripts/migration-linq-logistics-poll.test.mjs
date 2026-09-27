import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// VIL-377 (rule #9): logistics votes need to know which choice they are.
// Four nullable columns. Year-find rows stay null. Nothing destructive.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0134_linq_logistics_poll';

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

describe('0134_linq_logistics_poll is additive-only', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('adds four nullable columns, idempotently', () => {
    expect(sql).toContain(
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "poll_kind" text',
    );
    expect(sql).toContain(
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "subject_key" text',
    );
    expect(sql).toContain(
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_kind" text',
    );
    expect(sql).toContain(
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_value" text',
    );
  });

  it('contains only those four statements — nothing destructive', () => {
    const statements = statementsOf(sql);
    expect(statements).toEqual([
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "poll_kind" text;',
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "subject_key" text;',
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_kind" text;',
      'ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_value" text;',
    ]);
    for (const stmt of statements) {
      for (const forbidden of ['DROP', 'RENAME', 'DELETE', 'UPDATE']) {
        expect(stmt.toUpperCase()).not.toContain(forbidden);
      }
    }
  });

  it('is journaled immediately after 0133_group_decision_sync', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0133_group_decision_sync') + 1);
  });
});

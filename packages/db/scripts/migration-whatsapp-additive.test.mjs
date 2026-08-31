import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// WhatsApp v1 (rule #9): the ledger's channel enum gains 'whatsapp' and NOTHING else
// changes. This pins the migration to the additive-only shape — a hand-written
// ALTER TYPE ... ADD VALUE guarded with IF NOT EXISTS (safe on re-run and on an
// environment where a hotfix already added it), journaled, and free of any statement
// that could drop, rename, or rewrite what production already holds.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0104_whatsapp_channel';

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

describe('0104_whatsapp_channel is additive-only', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('adds the whatsapp value to channel_message_channel, idempotently', () => {
    expect(sql).toContain(
      `ALTER TYPE "public"."channel_message_channel" ADD VALUE IF NOT EXISTS 'whatsapp'`,
    );
  });

  it('contains ONLY ADD VALUE IF NOT EXISTS statements — nothing destructive', () => {
    const statements = statementsOf(sql);
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).toMatch(/^ALTER TYPE "public"\."[a-z_]+" ADD VALUE IF NOT EXISTS '[a-z_]+';?$/);
      // Belt and braces over the same statements (comments are prose, not SQL):
      for (const forbidden of ['DROP', 'RENAME', 'DELETE', 'UPDATE', 'ALTER TABLE', 'CREATE TABLE']) {
        expect(stmt.toUpperCase()).not.toContain(forbidden);
      }
    }
  });

  it('is journaled after the last shipped migration', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags[tags.length - 1]).toBe(TAG);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0103_reply_source') + 1);
  });
});

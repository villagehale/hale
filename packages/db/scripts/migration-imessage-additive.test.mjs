import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// VIL-335 (rule #9): the ledger's channel enum gains 'imessage' and the inbound
// row gains a nullable provider_chat_id. Nothing else. Both statements are
// re-runnable (IF NOT EXISTS).

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0130_imessage_linq_channel';

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

describe('0130_imessage_linq_channel is additive-only', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('adds the imessage value and a nullable chat id, idempotently', () => {
    expect(sql).toContain(
      `ALTER TYPE "public"."channel_message_channel" ADD VALUE IF NOT EXISTS 'imessage'`,
    );
    expect(sql).toContain(
      'ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "provider_chat_id" text',
    );
  });

  it('contains only those two statements — nothing destructive', () => {
    const statements = statementsOf(sql);
    expect(statements).toEqual([
      `ALTER TYPE "public"."channel_message_channel" ADD VALUE IF NOT EXISTS 'imessage';`,
      'ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "provider_chat_id" text;',
    ]);
    for (const stmt of statements) {
      for (const forbidden of ['DROP', 'RENAME', 'DELETE', 'UPDATE']) {
        expect(stmt.toUpperCase()).not.toContain(forbidden);
      }
    }
  });

  it('is journaled immediately after 0129_registration_district_discovery', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0129_registration_district_discovery') + 1);
  });
});

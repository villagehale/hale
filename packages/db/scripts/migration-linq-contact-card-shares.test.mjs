import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// Once-per-chat memory for the Linq Name and Photo share. A row means the
// card was accepted for that chat. The table holds a chat id, not a phone.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0144_linq_contact_card_shares';

describe('0144_linq_contact_card_shares is additive', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('creates the per-chat share table and turns on row level security', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "linq_contact_card_shares"');
    expect(sql).toContain('"chat_id" text PRIMARY KEY NOT NULL');
    expect(sql).toContain('"shared_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(sql).toContain('ALTER TABLE "linq_contact_card_shares" ENABLE ROW LEVEL SECURITY');
  });

  it('does not delete or alter existing tables', () => {
    const statements = sql.replace(/--[^\n]*/g, '').toUpperCase();
    expect(statements).not.toContain('DELETE FROM');
    expect(statements).not.toContain('DROP TABLE');
    expect(statements).not.toContain('DROP COLUMN');
    expect(statements).not.toContain('TRUNCATE');
    expect(statements).not.toContain('ALTER TABLE "FAMILIES"');
    expect(statements).not.toContain('ALTER TABLE "PARENT_CHANNELS"');
  });

  it('is journaled immediately after 0143_duty_calendar_sync', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0143_duty_calendar_sync') + 1);
  });
});

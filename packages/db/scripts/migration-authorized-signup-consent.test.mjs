import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0138_authorized_signup_consent';

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

describe('0138_authorized_signup_consent', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('is journaled immediately after 0137_authorized_signup', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0137_authorized_signup') + 1);
  });

  it('creates the consent table with the grant columns and the closed field list', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "authorized_signup_consents"');
    for (const column of [
      '"message_id" text NOT NULL',
      '"family_id" uuid NOT NULL',
      '"activity_key" text NOT NULL',
      '"provider_host" text NOT NULL',
      '"fields_allowed" text[] NOT NULL',
      '"created_at" timestamp with time zone DEFAULT now() NOT NULL',
    ]) {
      expect(sql).toContain(column);
    }
    for (const field of [
      'child_first_name',
      'child_last_name',
      'child_dob',
      'parent_first_name',
      'parent_email',
      'postal_code',
      'session',
      'visit_date',
      'party_size',
      'seating_note',
    ]) {
      expect(sql).toContain(`'${field}'`);
    }
  });

  it('enables RLS and does not drop or delete', () => {
    expect(sql).toContain('ALTER TABLE "authorized_signup_consents" ENABLE ROW LEVEL SECURITY');
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

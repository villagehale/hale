import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// VIL-402 (rule #9): a no-picks trip records when it was searched and when it
// may be searched again. Nullable columns, so every existing trip stays valid.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0144_family_trips_no_picks_backoff';

describe('0144_family_trips_no_picks_backoff is additive', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('adds the two nullable attempt timestamps', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "last_attempt_at"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "next_attempt_at"');
    expect(sql).toContain('family_trips_attempt_pair_check');
    expect(sql).toContain('family_trips_attempt_order_check');
  });

  it('does not delete rows or columns', () => {
    const statements = sql.replace(/--[^\n]*/g, '').toUpperCase();
    expect(statements).not.toContain('DELETE FROM');
    expect(statements).not.toContain('DROP TABLE');
    expect(statements).not.toContain('DROP COLUMN');
    expect(statements).not.toContain('TRUNCATE');
  });

  it('is journaled immediately after 0143_duty_calendar_sync', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0143_duty_calendar_sync') + 1);
  });
});

// Prod recorded 0144's `when` for the reverted linq contact-card migration, so
// drizzle treats 0144 as applied and never creates the columns. The travel-brief
// select on the nudge cron reads them off the Drizzle schema. A database whose
// watermark is already 0149 only runs a migration whose `when` is later.
const LATER_TAG = '0150_family_trips_attempt_columns';
const WATERMARK_TAG = '0149_reply_copy_agent_name';
const SCHEMA = path.resolve(scriptDir, '..', 'src', 'schema', 'family-trips.ts');

describe('0150_family_trips_attempt_columns still applies after the 0149 watermark', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${LATER_TAG}.sql`), 'utf8');

  it('adds the two nullable attempt timestamps idempotently', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "last_attempt_at"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "next_attempt_at"');
    expect(sql).toContain('family_trips_attempt_pair_check');
    expect(sql).toContain('family_trips_attempt_order_check');
  });

  it('does not delete rows or columns', () => {
    const statements = sql.replace(/--[^\n]*/g, '').toUpperCase();
    expect(statements).not.toContain('DELETE FROM');
    expect(statements).not.toContain('DROP TABLE');
    expect(statements).not.toContain('DROP COLUMN');
    expect(statements).not.toContain('TRUNCATE');
  });

  it('is journaled immediately after 0149, with a strictly later when', () => {
    const journal = readJournal(drizzleDir);
    const tags = journal.map((entry) => entry.tag);
    expect(tags.indexOf(LATER_TAG)).toBe(tags.indexOf(WATERMARK_TAG) + 1);
    const watermark = journal.find((entry) => entry.tag === WATERMARK_TAG);
    const later = journal.find((entry) => entry.tag === LATER_TAG);
    expect(later.when).toBeGreaterThan(watermark.when);
  });

  it('the schema columns the nudge sweep reads are created past the 0149 watermark', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const columns = [...schema.matchAll(/timestamp\('([a-z0-9_]+)'/g)].map((match) => match[1]);
    expect(columns).toEqual(expect.arrayContaining(['last_attempt_at', 'next_attempt_at']));

    const journal = readJournal(drizzleDir);
    const watermark = journal.find((entry) => entry.tag === WATERMARK_TAG).when;
    const applicable = journal
      .filter((entry) => entry.when > watermark)
      .map((entry) => fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), 'utf8'))
      .join('\n');

    for (const column of ['last_attempt_at', 'next_attempt_at']) {
      expect(applicable).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// VIL-378: watched_sources + social_spots. Additive, re-runnable, RLS on.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0135_social_watchlist';

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

describe('0135_social_watchlist', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('is journaled immediately after 0134_linq_logistics_poll', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0134_linq_logistics_poll') + 1);
  });

  it('creates the region enum and both tables', () => {
    expect(sql).toContain(
      `CREATE TYPE "public"."gta_region" AS ENUM('toronto', 'peel', 'york', 'halton', 'durham', 'day_trip')`,
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "watched_sources"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "social_spots"');
    for (const column of [
      '"platform"',
      '"handle"',
      '"category"',
      '"region" "gta_region"',
      '"geo_fsa"',
      '"ingest_method"',
      '"tos_risk"',
      '"civic_venue_id"',
      '"last_media_id"',
    ]) {
      expect(sql).toContain(column);
    }
    for (const column of [
      '"platform_media_id"',
      '"permalink"',
      '"age_min"',
      '"age_max"',
      '"registration_opens_at"',
      '"registration_url"',
      '"extraction_confidence"',
      '"watch_status"',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('enables RLS on both new tables and does not drop anything', () => {
    expect(sql).toContain('ALTER TABLE "watched_sources" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "social_spots" ENABLE ROW LEVEL SECURITY');
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

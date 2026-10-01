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

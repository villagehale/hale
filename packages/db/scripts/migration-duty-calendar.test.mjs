import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// VIL-383 (rule #9): duty owner columns on family_events, and a wider
// decision check so 1:1 duty decisions can share group_decision_sync.
// Nullable columns. Existing picked/passed rows still satisfy the check.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const TAG = '0143_duty_calendar_sync';

describe('0143_duty_calendar_sync is additive', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), 'utf8');

  it('adds nullable duty columns and the fact index', () => {
    for (const column of [
      'duty_owner_user_id',
      'duty_owner_label',
      'duty_owner_kind',
      'duty_role',
      'duty_fact_key',
      'duty_set_at',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "family_events_duty_fact_idx"');
  });

  it('widens the sync check to duty and does not delete rows', () => {
    expect(sql).toContain(`"decision" IN ('picked', 'passed', 'duty')`);
    expect(sql).toContain(`"decision" = 'duty'`);
    const statements = sql
      .replace(/--[^\n]*/g, '')
      .toUpperCase();
    expect(statements).not.toContain('DELETE FROM');
    expect(statements).not.toContain('DROP TABLE');
    expect(statements).not.toContain('DROP COLUMN');
    expect(statements).not.toContain('TRUNCATE');
  });

  it('is journaled immediately after 0142_google_push_subscriptions', () => {
    const tags = readJournal(drizzleDir).map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0142_google_push_subscriptions') + 1);
  });
});

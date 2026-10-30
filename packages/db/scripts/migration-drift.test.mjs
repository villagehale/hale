import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeDrift, readJournalWithHashes } from './migration-drift.mjs';

describe('catalog history cutover', () => {
  it('routes the normal migration command through the same guarded entry point', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.migrate).toBe('node scripts/apply-migrations.mjs');
    expect(pkg.scripts['migrate:guard']).toBe(pkg.scripts.migrate);
  });
  it('keeps the retirement pending after the current main watermark', () => {
    const entries = readJournalWithHashes(fileURLToPath(new URL('../drizzle/', import.meta.url)));
    const base = entries.find((entry) => entry.tag === '0171_channel_pending_asks');
    expect(computeDrift(entries, base.when).pending.map((entry) => entry.tag)).toEqual([
      '0172_activity_history_only',
      '0173_provider_signup_sessions',
      '0174_family_link_wallets',
      '0175_signup_browser_use_cost',
      '0177_provider_watch',
      '0178_user_timezone_from_postal',
      '0179_channel_inbound_media',
      '0184_preview_captured_sends',
      '0192_preview_captured_linq_calls',
      '0185_channel_inbound_in_group',
      '0193_family_events_source_change',
      '0194_preview_captured_sends_decorations',
      '0180_linq_group_plans',
      '0189_group_reminders',
      '0188_family_events_group_plan_copy_key',
      '0195_linq_shared_group_people',
      '0190_linq_group_polls',
    ]);
  });
});

// Journal `when` values are strictly increasing (as drizzle-kit emits them).
// Expected verdicts are derived from drizzle's own apply rule — a journal entry
// is applied iff `entry.when <= max(created_at)` in the DB — NOT copied from the
// function's output.
const journal = [
  { tag: '0000_baseline', when: 1000 },
  { tag: '0001_alpha', when: 2000 },
  { tag: '0002_beta', when: 3000 },
  { tag: '0003_gamma', when: 4000 },
];

describe('computeDrift', () => {
  it('reports behind when the DB watermark is older than later entries', () => {
    // DB applied up to when=2000 → 0002 and 0003 are pending.
    const result = computeDrift(journal, 2000);
    expect(result.behind).toBe(true);
    expect(result.appliedCount).toBe(2);
    expect(result.pending.map((p) => p.tag)).toEqual(['0002_beta', '0003_gamma']);
    expect(result.journalCount).toBe(4);
  });

  it('reports in sync when the DB watermark equals the newest entry', () => {
    const result = computeDrift(journal, 4000);
    expect(result.behind).toBe(false);
    expect(result.appliedCount).toBe(4);
    expect(result.pending).toEqual([]);
  });

  it('treats a fresh DB (no migrations table) as fully behind', () => {
    const result = computeDrift(journal, null);
    expect(result.behind).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(result.pending).toHaveLength(4);
  });

  it('flags a single missing migration — the exact 12-behind shape from the incident', () => {
    // Watermark at the 24th migration; 12 later entries are un-applied.
    const long = Array.from({ length: 36 }, (_, i) => ({
      tag: `m${String(i).padStart(4, '0')}`,
      when: (i + 1) * 1000,
    }));
    const watermark = 24 * 1000;
    const result = computeDrift(long, watermark);
    expect(result.behind).toBe(true);
    expect(result.pending).toHaveLength(12);
    expect(result.appliedCount).toBe(24);
  });
});

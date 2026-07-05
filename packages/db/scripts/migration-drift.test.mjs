import { describe, expect, it } from 'vitest';
import { computeDrift } from './migration-drift.mjs';

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

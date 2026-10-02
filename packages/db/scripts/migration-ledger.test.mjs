import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import {
  computeLedgerDrift,
  describeLedgerDrift,
  readExemptionTags,
  readJournal,
  readJournalWithHashes,
} from './migration-drift.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');
const exemptionsPath = path.resolve(scriptDir, 'ledger-exemptions.json');

const journal = [
  { tag: '0000_baseline', when: 1000, hash: 'h0' },
  { tag: '0144_replaced', when: 2000, hash: 'h-new' },
  { tag: '0149_applied', when: 3000, hash: 'h149' },
  { tag: '0150_pending', when: 4000, hash: 'h150' },
];

describe('computeLedgerDrift', () => {
  it('treats a missing migrations table as fully pending and ignores exemptions', () => {
    const result = computeLedgerDrift(journal, null, new Set(['0144_replaced']));
    expect(result.behind).toBe(true);
    expect(result.appliedCount).toBe(0);
    expect(result.exempted).toEqual([]);
    expect(result.pending.map((entry) => entry.tag)).toEqual(journal.map((entry) => entry.tag));
  });

  it('treats an empty ledger the same as a missing table', () => {
    const result = computeLedgerDrift(journal, [], new Set(['0144_replaced']));
    expect(result.behind).toBe(true);
    expect(result.pending).toHaveLength(journal.length);
    expect(result.exempted).toEqual([]);
  });

  it('reports in sync only when every current file hash is recorded', () => {
    const ledger = journal.map((entry) => ({ hash: entry.hash, createdAt: entry.when }));
    const result = computeLedgerDrift(journal, ledger, new Set());
    expect(result.behind).toBe(false);
    expect(result.pending).toEqual([]);
    expect(result.appliedCount).toBe(journal.length);
    expect(describeLedgerDrift(result).ok).toBe(true);
  });

  it('fails a hash that was never recorded even when a later watermark covers its when', () => {
    // 0150's when is behind the watermark because 0149... wait, 0150 when is 4000
    // and the ledger's max is 5000 from a later file. 0150 itself was skipped.
    const ledger = [
      { hash: 'h0', createdAt: 1000 },
      { hash: 'h149', createdAt: 3000 },
      { hash: 'h151', createdAt: 5000 },
    ];
    const result = computeLedgerDrift(journal, ledger, new Set());
    expect(result.behind).toBe(true);
    expect(result.pending.map((entry) => entry.tag)).toEqual(['0144_replaced', '0150_pending']);
    expect(result.skippedByWatermark.map((entry) => entry.tag)).toEqual([
      '0144_replaced',
      '0150_pending',
    ]);
    const report = describeLedgerDrift(result);
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('0150_pending');
    expect(report.lines.join('\n')).toContain('later `when`');
  });

  it('exempts a reused when only when that created_at is already in the ledger', () => {
    const ledger = [
      { hash: 'h0', createdAt: 1000 },
      { hash: 'h-old-linq', createdAt: 2000 },
      { hash: 'h149', createdAt: 3000 },
      { hash: 'h150', createdAt: 4000 },
    ];
    const exempt = computeLedgerDrift(journal, ledger, new Set(['0144_replaced']));
    expect(exempt.behind).toBe(false);
    expect(exempt.exempted.map((entry) => entry.tag)).toEqual(['0144_replaced']);
    expect(exempt.pending).toEqual([]);

    const notExempt = computeLedgerDrift(journal, ledger, new Set());
    expect(notExempt.behind).toBe(true);
    expect(notExempt.pending.map((entry) => entry.tag)).toEqual(['0144_replaced']);
  });

  it('does not let an exemption hide a when the ledger has never recorded', () => {
    const ledger = [{ hash: 'h0', createdAt: 1000 }];
    const result = computeLedgerDrift(journal, ledger, new Set(['0150_pending']));
    expect(result.pending.map((entry) => entry.tag)).toContain('0150_pending');
    expect(result.exempted).toEqual([]);
  });

  it('fails closed when an exemption names a tag that is not in the journal', () => {
    const ledger = journal.map((entry) => ({ hash: entry.hash, createdAt: entry.when }));
    const result = computeLedgerDrift(journal, ledger, new Set(['not_a_migration']));
    expect(result.behind).toBe(true);
    expect(result.unknownExemptions).toEqual(['not_a_migration']);
    expect(describeLedgerDrift(result).ok).toBe(false);
  });
});

describe('journal hashes match drizzle-orm', () => {
  it('uses the same sha256 and folderMillis drizzle migrate records', () => {
    const ours = readJournalWithHashes(drizzleDir);
    const theirs = readMigrationFiles({ migrationsFolder: drizzleDir });
    expect(ours.map((entry) => entry.hash)).toEqual(theirs.map((entry) => entry.hash));
    expect(ours.map((entry) => entry.when)).toEqual(theirs.map((entry) => entry.folderMillis));
  });
});

describe('ledger exemptions file', () => {
  it('names only the historical hash mismatches, each with a reason, each in the journal', () => {
    const tags = readExemptionTags(exemptionsPath);
    expect([...tags].sort()).toEqual([
      '0055_family_events',
      '0063_event_reminders',
      '0098_coparent_join_link',
      '0105_channel_signin_token',
      '0144_family_trips_no_picks_backoff',
    ]);
    const journalTags = new Set(readJournal(drizzleDir).map((entry) => entry.tag));
    for (const tag of tags) expect(journalTags.has(tag)).toBe(true);
  });
});

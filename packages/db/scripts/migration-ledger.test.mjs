import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import {
  computeLedgerDrift,
  describeLedgerDrift,
  readExemptions,
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

  it('keeps a superseded file pending until the later migration hash is recorded', () => {
    const withSuccessor = [...journal, { tag: '0155_repair', when: 5000, hash: 'h155' }];
    const rules = [
      { tag: '0144_replaced', reason: 'tables ship later', supersededBy: '0155_repair' },
    ];
    const before = computeLedgerDrift(
      withSuccessor,
      [
        { hash: 'h0', createdAt: 1000 },
        { hash: 'h149', createdAt: 3000 },
        { hash: 'h150', createdAt: 4000 },
      ],
      rules,
    );
    expect(before.behind).toBe(true);
    expect(before.pending.map((entry) => entry.tag)).toEqual(['0144_replaced', '0155_repair']);
    expect(before.blockedBySuccessor).toEqual(['0144_replaced']);
    expect(before.exempted).toEqual([]);
    expect(describeLedgerDrift(before).lines.join('\n')).toContain('superseded_by');

    const after = computeLedgerDrift(
      withSuccessor,
      [
        { hash: 'h0', createdAt: 1000 },
        { hash: 'h149', createdAt: 3000 },
        { hash: 'h150', createdAt: 4000 },
        { hash: 'h155', createdAt: 5000 },
      ],
      rules,
    );
    expect(after.behind).toBe(false);
    expect(after.exempted.map((entry) => entry.tag)).toEqual(['0144_replaced']);
    expect(after.pending).toEqual([]);
  });

  it('does not accept superseded_by when the named file is missing or not later', () => {
    const rules = [{ tag: '0144_replaced', reason: 'bad pointer', supersededBy: '0000_baseline' }];
    const ledger = journal
      .filter((entry) => entry.tag !== '0144_replaced')
      .map((entry) => ({ hash: entry.hash, createdAt: entry.when }));
    const earlier = computeLedgerDrift(journal, ledger, rules);
    expect(earlier.behind).toBe(true);
    expect(earlier.invalidSupersessions).toEqual(['0144_replaced']);
    expect(earlier.pending.map((entry) => entry.tag)).toContain('0144_replaced');
    expect(describeLedgerDrift(earlier).lines.join('\n')).toContain('later journal migration');

    const missing = computeLedgerDrift(journal, ledger, [
      { tag: '0144_replaced', reason: 'bad pointer', supersededBy: 'no_such_file' },
    ]);
    expect(missing.invalidSupersessions).toEqual(['0144_replaced']);
    expect(missing.behind).toBe(true);
  });

  it('accepts a schema gap only when the caller proved the column', () => {
    const rules = [
      {
        tag: '0144_replaced',
        reason: 'column already exists',
        schema: { table: 'conversations', column: 'note_key', index: 'conversations_note_idx' },
      },
    ];
    const ledger = [
      { hash: 'h0', createdAt: 1000 },
      { hash: 'h149', createdAt: 3000 },
      { hash: 'h150', createdAt: 4000 },
    ];
    const unproven = computeLedgerDrift(journal, ledger, rules, new Set());
    expect(unproven.behind).toBe(true);
    expect(unproven.unprovenSchema).toEqual(['0144_replaced']);
    expect(unproven.pending.map((entry) => entry.tag)).toEqual(['0144_replaced']);
    expect(describeLedgerDrift(unproven).lines.join('\n')).toContain('not a blanket skip');

    const proven = computeLedgerDrift(journal, ledger, rules, new Set(['0144_replaced']));
    expect(proven.behind).toBe(false);
    expect(proven.exempted.map((entry) => entry.tag)).toEqual(['0144_replaced']);
  });

  it('ignores superseded_by and schema proof when the ledger is empty', () => {
    const rules = [
      { tag: '0144_replaced', reason: 'later file', supersededBy: '0150_pending' },
      {
        tag: '0000_baseline',
        reason: 'column exists',
        schema: { table: 'conversations', column: 'note_key' },
      },
    ];
    const result = computeLedgerDrift(journal, [], rules, new Set(['0000_baseline']));
    expect(result.behind).toBe(true);
    expect(result.exempted).toEqual([]);
    expect(result.pending).toHaveLength(journal.length);
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
  it('documents the historical when-recorded gaps plus the 0127 and 0049 proofs', () => {
    const entries = readExemptions(exemptionsPath);
    expect(entries.map((entry) => entry.tag).sort()).toEqual([
      '0049_conversation_note_key',
      '0055_family_events',
      '0063_event_reminders',
      '0098_coparent_join_link',
      '0105_channel_signin_token',
      '0127_instinct_memory',
      '0144_family_trips_no_picks_backoff',
    ]);
    const journalEntries = readJournal(drizzleDir);
    const byTag = new Map(journalEntries.map((entry) => [entry.tag, entry]));
    for (const entry of entries) expect(byTag.has(entry.tag)).toBe(true);

    const historical = [
      '0055_family_events',
      '0063_event_reminders',
      '0098_coparent_join_link',
      '0105_channel_signin_token',
      '0144_family_trips_no_picks_backoff',
    ];
    for (const tag of historical) {
      const entry = entries.find((item) => item.tag === tag);
      expect(entry?.supersededBy).toBeUndefined();
      expect(entry?.schema).toBeUndefined();
    }

    const instinct = entries.find((entry) => entry.tag === '0127_instinct_memory');
    expect(instinct?.supersededBy).toBe('0155_instinct_memory_tables');
    const repair = byTag.get('0155_instinct_memory_tables');
    const original = byTag.get('0127_instinct_memory');
    expect(repair).toBeDefined();
    expect(original).toBeDefined();
    expect(repair.when).toBeGreaterThan(original.when);
    expect(repair.when).toBeGreaterThan(1781469648000);

    const noteKey = entries.find((entry) => entry.tag === '0049_conversation_note_key');
    expect(noteKey?.schema).toEqual({
      table: 'conversations',
      column: 'note_key',
      index: 'conversations_family_note_key_idx',
    });
  });
});

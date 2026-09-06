import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournal } from './migration-drift.mjs';

// Guards the invariant behind incident 2026-06-14: `drizzle-kit migrate` and the
// drift gate act on the JOURNAL, so a `.sql` file absent from _journal.json is
// never applied AND never flagged pending (it silently never exists in prod),
// while a journal entry with no `.sql` file makes `migrate` throw at deploy.
// Neither shape is caught by computeDrift's synthetic-journal unit tests, so this
// checks the real journal against the real files on disk.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

describe('migration journal ↔ file consistency', () => {
  it('every migration .sql file has exactly one journal entry and vice versa', () => {
    const fileTags = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -'.sql'.length))
      .sort();
    const journalTags = readJournal(drizzleDir)
      .map((e) => e.tag)
      .sort();

    expect(journalTags).toEqual(fileTags);
  });

  it('gives every entry a `when` strictly greater than the one before it', () => {
    // The other half of the same 2026-06-14 shape, and the one hand-assigned `when`
    // gets wrong: drizzle applies an entry only where `when` > the greatest applied
    // `created_at`, and computeDrift calls an entry pending on the same comparison. So
    // a `when` equal to or below the tail's is applied by nobody AND reported pending
    // by nobody — the migration silently never exists in prod, exactly as a missing
    // journal entry does. Sibling branches assign `when` by hand, so the ordering the
    // tail depends on is a thing a merge can quietly break.
    const journal = readJournal(drizzleDir);
    const outOfOrder = journal
      .map((entry, i) => ({ entry, previous: journal[i - 1] }))
      .filter(({ entry, previous }) => previous !== undefined && entry.when <= previous.when)
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (${entry.when}) <= ${previous.tag} (${previous.when})`,
      );

    expect(outOfOrder).toEqual([]);
  });
});

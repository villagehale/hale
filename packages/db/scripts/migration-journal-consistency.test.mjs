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
});

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
//
// Number prefixes and idx are the other half: two files that share a prefix, or
// an idx that goes backwards, is how a hand-assigned migration lands in the wrong
// slot. The three shipped 0225_* files are the only prefix that may repeat.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(scriptDir, '..', 'drizzle');

/** Shipped tags that already share a number prefix. A new duplicate is not allowed. */
const DUPLICATE_PREFIX_ALLOWLIST = [
  '0225_sms_intake_sessions_became_family',
  '0225_linq_group_plan_calendar_consent',
  '0225_messages_provider_message_id',
];

function readJournalFile() {
  return JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'));
}

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

  it('gives every migration a unique number prefix, except the shipped 0225 duplicates', () => {
    const tags = readJournalFile().entries.map((entry) => entry.tag);
    const allow = new Set(DUPLICATE_PREFIX_ALLOWLIST);
    /** @type {Map<string, string[]>} */
    const groups = new Map();
    /** @type {string[]} */
    const problems = [];

    for (const tag of DUPLICATE_PREFIX_ALLOWLIST) {
      if (!tags.includes(tag)) problems.push(`${tag} is allowlisted but not in the journal`);
    }

    for (const tag of tags) {
      const match = /^(\d+)_/.exec(tag);
      if (!match) {
        problems.push(`${tag} has no number prefix`);
        continue;
      }
      const group = groups.get(match[1]) ?? [];
      group.push(tag);
      groups.set(match[1], group);
    }

    for (const [prefix, group] of groups) {
      if (group.length === 1) continue;
      const unexpected = group.filter((tag) => !allow.has(tag));
      if (unexpected.length > 0) {
        problems.push(`prefix ${prefix} is reused by ${group.join(', ')}`);
      }
    }

    for (const tag of DUPLICATE_PREFIX_ALLOWLIST) {
      const match = /^(\d+)_/.exec(tag);
      const group = match ? (groups.get(match[1]) ?? []) : [];
      if (group.length < 2) {
        problems.push(`${tag} is allowlisted but prefix ${match?.[1] ?? '?'} is not duplicated`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('gives every entry a unique, strictly increasing idx', () => {
    const entries = readJournalFile().entries;
    const seen = new Set();
    /** @type {string[]} */
    const problems = [];
    for (let i = 0; i < entries.length; i++) {
      const idx = entries[i].idx;
      if (seen.has(idx)) problems.push(`duplicate idx ${idx} on ${entries[i].tag}`);
      seen.add(idx);
      const previous = entries[i - 1];
      if (previous !== undefined && !(idx > previous.idx)) {
        problems.push(
          `${entries[i].tag} idx ${idx} is not greater than ${previous.tag} idx ${previous.idx}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

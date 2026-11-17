// Print the next free migration number, idx, and when.
//
// Reads the drizzle journal only. Does not create a file. The number is one
// past the highest prefix already in the journal, so a gap stays a gap. idx is
// one past the highest idx, which keeps the journal strictly increasing even
// where an earlier idx was skipped. when is now, or one past the latest when
// when the journal is already ahead of the clock.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const journalPath = path.resolve(scriptDir, '..', 'drizzle', 'meta', '_journal.json');

/**
 * @param {{ tag: string, idx: number, when: number }[]} entries
 * @param {number} [now]
 * @returns {{ number: string, idx: number, when: number }}
 */
export function nextMigration(entries, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('journal has no entries');
  }
  let maxNumber = -1;
  let maxPrefix = '';
  let maxIdx = -1;
  let maxWhen = -1;
  for (const entry of entries) {
    const match = /^(\d+)_/.exec(String(entry.tag ?? ''));
    if (!match) throw new Error(`migration tag has no number prefix: ${entry.tag}`);
    const value = Number(match[1]);
    if (value > maxNumber || (value === maxNumber && match[1].length > maxPrefix.length)) {
      maxNumber = value;
      maxPrefix = match[1];
    }
    if (!Number.isInteger(entry.idx)) throw new Error(`${entry.tag} idx is not an integer`);
    if (!Number.isInteger(entry.when)) throw new Error(`${entry.tag} when is not an integer`);
    if (entry.idx > maxIdx) maxIdx = entry.idx;
    if (entry.when > maxWhen) maxWhen = entry.when;
  }
  return {
    number: String(maxNumber + 1).padStart(maxPrefix.length, '0'),
    idx: maxIdx + 1,
    when: Math.max(now, maxWhen + 1),
  };
}

/**
 * @param {{ number: string, idx: number, when: number }} next
 */
export function formatNextMigration(next) {
  return `number ${next.number}\nidx ${next.idx}\nwhen ${next.when}\n`;
}

function main() {
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  process.stdout.write(formatNextMigration(nextMigration(journal.entries)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatNextMigration, nextMigration } from './next-migration.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

describe('nextMigration', () => {
  it('takes one past the highest number, idx, and when', () => {
    expect(
      nextMigration(
        [
          { tag: '0001_a', idx: 0, when: 10 },
          { tag: '0003_b', idx: 2, when: 30 },
          { tag: '0003_c', idx: 4, when: 40 },
        ],
        100,
      ),
    ).toEqual({ number: '0004', idx: 5, when: 100 });
  });

  it('stays strictly after a when that is already in the future', () => {
    expect(nextMigration([{ tag: '0257_a', idx: 245, when: 5000 }], 100)).toEqual({
      number: '0258',
      idx: 246,
      when: 5001,
    });
  });

  it('prints number, idx, and when for the real journal', () => {
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    const before = Date.now();
    const result = spawnSync(process.execPath, [path.join(scriptDir, 'next-migration.mjs')], {
      encoding: 'utf8',
    });
    const after = Date.now();
    expect(result.status).toBe(0);
    const expected = nextMigration(journal.entries, before);
    const maxWhen = Math.max(...journal.entries.map((entry) => entry.when));
    expect(result.stdout).toBe(
      formatNextMigration({
        ...expected,
        when: Number(result.stdout.match(/when (\d+)/)?.[1]),
      }),
    );
    const when = Number(result.stdout.match(/when (\d+)/)?.[1]);
    expect(when).toBeGreaterThanOrEqual(Math.max(before, maxWhen + 1));
    expect(when).toBeLessThanOrEqual(Math.max(after, maxWhen + 1));
    expect(result.stdout.startsWith(`number ${expected.number}\nidx ${expected.idx}\n`)).toBe(true);
  });

  it('is the root db:next-migration script', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['db:next-migration']).toBe('node packages/db/scripts/next-migration.mjs');
  });
});

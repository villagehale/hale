import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * /admin is STRICTLY read-only — no POST/PUT/PATCH/DELETE handler and no
 * server action anywhere under the route tree or the admin lib. Structural, so
 * a future panel cannot quietly grow a mutation the reviewer never sees.
 */

const ROOTS = ['../../app/(authed)/admin', '.'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('the /admin surface is read-only', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('finds the route tree at all (positive control)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('exports no mutating route handler', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(
        /export\s+(async\s+)?(const|function)\s+(POST|PUT|PATCH|DELETE)\b/.test(src),
        `${file} exports a mutating handler`,
      ).toBe(false);
    }
  });

  it('contains no server action', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(/['"]use server['"]/.test(src), `${file} declares a server action`).toBe(false);
    }
  });

  it('the mutation regexes would actually catch one (positive control)', () => {
    expect(/export\s+(async\s+)?(const|function)\s+(POST|PUT|PATCH|DELETE)\b/.test(
      'export async function POST() {}',
    )).toBe(true);
    expect(/['"]use server['"]/.test("'use server';")).toBe(true);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dummy family is gone. 'M...a is 4, T...o is 18 months' was a prefill two
 * strangers would have had to edit before sending; nothing in apps/site may
 * reintroduce it, encoded or plain.
 */

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the dummy family is gone from apps/site', () => {
  // Assembled so this file cannot match its own patterns.
  const first = ['Ma', 'ya'].join('');
  const second = ['Th', 'eo'].join('');
  // The ban is the old composer prefill (first name + "is 4", second + "is 18"),
  // which two strangers would have had to edit before sending. The approved
  // marketing examples use the second name at a different age.
  const patterns = [
    new RegExp(`${first}(?:\\s|%20)+is`),
    new RegExp(`${second}(?:\\s|%20)+is(?:\\s|%20)+18`),
  ];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist', 'coverage', '.turbo'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (/\.(ts|tsx|js|mjs|json|txt|md|css)$/.test(name)) out.push(path);
    }
    return out;
  }

  it('no source file carries the sample family, plain or percent-encoded', () => {
    const files = walk(SITE_ROOT);
    expect(files.length).toBeGreaterThan(100); // positive control: the walk saw the tree
    const offenders = files.filter((file) => {
      const raw = readFileSync(file, 'utf8');
      return patterns.some((pattern) => pattern.test(raw));
    });
    expect(offenders).toEqual([]);
  });

  it('positive control: the patterns do catch the old prefill in both shapes', () => {
    expect(patterns[0]?.test(`${first} is 4`)).toBe(true);
    expect(patterns[0]?.test(`${first}%20is%204`)).toBe(true);
    expect(patterns[1]?.test(`${second} is 18 months`)).toBe(true);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_COPY_LOCKED_ENV,
  DUTY_PLACEHOLDER_STRINGS,
  absorbDutyLine,
  dutyCopyLocked,
  dutyCopyMayLeave,
} from './copy';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|mjs|sql|md)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe('duty copy lock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays unlocked unless the value is exactly true', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, '');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'TRUE');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true\n');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    expect(dutyCopyLocked()).toBe(true);
  });

  it('does not let a placeholder leave, even when the lock flag is on', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    for (const line of DUTY_PLACEHOLDER_STRINGS) {
      expect(line.startsWith('TODO-Design:')).toBe(true);
      expect(dutyCopyMayLeave(line)).toBe(false);
    }
    expect(absorbDutyLine('This week: swim.', DUTY_PLACEHOLDER_STRINGS[0])).toBe(
      'This week: swim.',
    );
  });

  it('keeps every placeholder in copy.ts and in no other file', () => {
    const copyPath = fileURLToPath(new URL('./copy.ts', import.meta.url));
    const copy = readFileSync(copyPath, 'utf8');
    const declared = [...copy.matchAll(/'(TODO-Design:[^']*)'/g)].map((match) => match[1]);
    expect(declared.slice().sort()).toEqual([...DUTY_PLACEHOLDER_STRINGS].slice().sort());
    const roots = [join(ROOT, 'apps'), join(ROOT, 'packages')];
    const leaks: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        if (file === copyPath) continue;
        const source = readFileSync(file, 'utf8');
        for (const line of DUTY_PLACEHOLDER_STRINGS) {
          if (source.includes(line)) leaks.push(`${file.slice(ROOT.length)}: ${line}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});

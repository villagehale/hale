import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Barton's rule: no fixed or template parent copy. A new `copy.ts` or
 * `*copy*.ts` under a channel code path is a new copy file. The allowlist is
 * the files that exist today. It may only shrink. Raising an allowlist needs
 * Barton's own words.
 *
 * This ratchet file's own name matches `*copy*.ts`. It is not a copy module,
 * so the scan does not list it.
 */
const ALLOWED = [
  'apps/web/lib/channel/checkin/copy.test.ts',
  'apps/web/lib/channel/checkin/copy.ts',
  'apps/web/lib/channel/connect/connect-page-copy.ts',
  'apps/web/lib/channel/connect/copy.test.ts',
  'apps/web/lib/channel/connect/copy.ts',
  'apps/web/lib/channel/coparent/copy.test.ts',
  'apps/web/lib/channel/coparent/copy.ts',
  'apps/web/lib/channel/coparent/duty/copy.test.ts',
  'apps/web/lib/channel/coparent/duty/copy.ts',
  'apps/web/lib/channel/founder/copy.ts',
  'apps/web/lib/channel/how-it-went-copy.test.ts',
  'apps/web/lib/channel/how-it-went-copy.ts',
  'apps/web/lib/channel/intake/copy.test.ts',
  'apps/web/lib/channel/intake/copy.ts',
  'apps/web/lib/channel/linq/group-coparent-copy.ts',
  'apps/web/lib/channel/off-domain/copy.test.ts',
  'apps/web/lib/channel/off-domain/copy.ts',
  'apps/web/lib/channel/rec-morning/copy.ts',
  'apps/web/lib/channel/router/copy.test.ts',
  'apps/web/lib/channel/router/copy.ts',
  'apps/web/lib/channel/same-activity/copy.test.ts',
  'apps/web/lib/channel/same-activity/copy.ts',
  'apps/web/lib/channel/sms-copy-encoding.test.ts',
  'apps/web/lib/channel/spots/copy.test.ts',
  'apps/web/lib/channel/spots/copy.ts',
  'apps/web/lib/channels/sms-consent-copy.test.ts',
  'apps/web/lib/channels/sms-consent-copy.ts',
] as const;

const SELF = 'apps/web/lib/channel/no-copy-files.guard.test.ts';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build']);

function isCopyModule(name: string): boolean {
  return name.includes('copy') && /\.ts$/.test(name);
}

function counted(rel: string): boolean {
  if (rel === SELF) return false;
  const parts = rel.split('/');
  if (!parts.some((part) => part === 'channel' || part === 'channels')) return false;
  return isCopyModule(parts[parts.length - 1] ?? '');
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full));
      continue;
    }
    out.push(relative(REPO_ROOT, full));
  }
  return out;
}

function copyFiles(): string[] {
  const found: string[] = [];
  for (const root of ['apps', 'packages']) {
    for (const rel of filesUnder(join(REPO_ROOT, root))) {
      if (counted(rel)) found.push(rel);
    }
  }
  return found.sort();
}

describe('channel copy files', () => {
  it('do not grow past today', () => {
    expect(copyFiles()).toEqual([...ALLOWED]);
  });

  it('positive control: copy.ts and *copy*.ts match, and this ratchet file is not listed', () => {
    expect(isCopyModule('copy.ts')).toBe(true);
    expect(isCopyModule('how-it-went-copy.ts')).toBe(true);
    expect(isCopyModule('sms-consent-copy.test.ts')).toBe(true);
    expect(isCopyModule('flag.ts')).toBe(false);
    expect(isCopyModule('copy.tsx')).toBe(false);
    expect(counted('apps/web/lib/channel/fresh/copy.ts')).toBe(true);
    expect(counted('apps/web/lib/signup/copy.ts')).toBe(false);
    expect(counted(SELF)).toBe(false);
    expect(copyFiles()).not.toContain(SELF);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-156 · ONE DOOR. Every way a parent's Google access ends goes through one primitive
 * (integrations/google-disconnect.ts), so the Google revoke and the push stop cannot be
 * forgotten by a path again: three of four paths had forgotten the push stop, and all
 * four had forgotten Google. The behaviour itself is pinned against pglite in
 * google-disconnect.pglite.test.ts; this pins that nothing goes around it.
 */

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

const FILES = sources(WEB_ROOT)
  .map((path) => relative(WEB_ROOT, path))
  .filter((path) => !path.startsWith('lib/testing/'));
const read = (path: string) => readFileSync(join(WEB_ROOT, path), 'utf8');

function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((path) => pattern.test(read(path)));
}

describe('every disconnect path goes through disconnectGoogle', () => {
  it('nulls the token column in exactly one place', () => {
    const writer = /oauth_?tokens_?encrypted\W{0,4}\s*[:=]\s*(null|NULL|sql`\s*NULL)/i;
    const hits = FILES.flatMap((path) =>
      (read(path).match(new RegExp(writer.source, 'gi')) ?? []).map(() => path),
    );
    // The one hit is also the positive control that the scan reads files at all.
    expect(hits).toEqual(['lib/integrations/store.ts']);
  });

  it('leaves no caller of the old single-connector revoke', () => {
    expect(filesMatching(/\brevokeConnection\b/)).toEqual([]);
  });

  it.each([
    'app/api/integrations/[provider]/disconnect/route.ts',
    'lib/integrations/load.ts',
    'lib/channel/connect/revoke.ts',
  ])('%s calls disconnectGoogle', (path) => {
    expect(read(path)).toContain('disconnectGoogle(');
  });

  it('co-parent departure ends the connectors in its transaction and settles them after', () => {
    const depart = read('lib/channel/coparent/depart.ts');
    expect(depart).toContain('endGoogleConnections(');
    expect(depart).toContain('settleGoogleRevocations(');
  });

  it('stops push only from the primitive', () => {
    // google-push-watch.ts holds the bare channel stop that the runtime wraps.
    expect(filesMatching(/stopGooglePush/).sort()).toEqual([
      'lib/integrations/google-disconnect.ts',
      'lib/integrations/google-push-runtime.ts',
      'lib/integrations/google-push-watch.ts',
    ]);
    expect(filesMatching(/stopGooglePushForEndedConnection/).sort()).toEqual([
      'lib/integrations/google-disconnect.ts',
      'lib/integrations/google-push-runtime.ts',
    ]);
  });
});

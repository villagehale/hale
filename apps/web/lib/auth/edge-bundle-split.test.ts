import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural tripwire for the Edge/Node auth split (the mobile-no-raw-db.test.ts
 * pattern, pointed at a different invariant).
 *
 * The middleware runs on the EDGE runtime and builds its Auth.js instance from
 * auth.config.ts. Node-only deps — argon2, node:crypto, the Postgres client — cannot
 * load there, so the rule is that everything REACHABLE from the middleware stays free
 * of them, and the providers whose authorize needs those deps live only in auth.ts.
 *
 * The rule is easy to break by accident and impossible to notice locally: a new
 * provider (or a helper it drags in) imported one file too high compiles fine, passes
 * every unit test, and fails at the edge in production. So this walks the real local
 * import graph from both Edge entrypoints rather than trusting a comment.
 */

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const EDGE_ENTRYPOINTS = ['auth.config.ts', 'middleware.ts'];

/** Anything that cannot exist in an Edge bundle. */
const NODE_ONLY = [
  /from\s+'node:/,
  /from\s+'argon2'/,
  /from\s+'@hale\/db'/,
  /from\s+'drizzle-orm/,
  /from\s+'pg'/,
  /from\s+'~\/lib\/db'/,
  /from\s+'~\/auth'/,
];

/**
 * Resolve a module specifier to the file it really is. The RESOLVED path is what the
 * graph is keyed on: keying on the specifier would make `has('…/foo.ts')` answer false
 * for a file that is very much in the bundle, and a reachability assertion that passes
 * because of a missing extension is worse than no assertion at all.
 */
function resolve(relPath: string): { path: string; source: string } | null {
  for (const candidate of [relPath, `${relPath}.ts`, `${relPath}.tsx`, `${relPath}/index.ts`]) {
    try {
      return { path: candidate, source: readFileSync(`${WEB_ROOT}/${candidate}`, 'utf8') };
    } catch {
      // try the next spelling
    }
  }
  return null;
}

function read(relPath: string): string | null {
  return resolve(relPath)?.source ?? null;
}

/** Local imports only — a bare package specifier is resolved by the bundler, not us. */
function localImports(source: string): string[] {
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
  return specifiers
    .filter((s) => s.startsWith('~/'))
    .map((s) => s.replace(/^~\//, ''))
    .filter((s) => !s.endsWith('.css'));
}

/** Every apps/web file the Edge bundle pulls in, transitively. */
function edgeReachableFiles(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [...EDGE_ENTRYPOINTS];

  while (queue.length > 0) {
    const specifier = queue.shift() as string;
    const resolved = resolve(specifier);
    // A specifier we cannot resolve is not a claim we can make — but it must not be
    // silently dropped either, or a renamed file would quietly shrink the graph.
    expect(resolved, `unresolvable local import: ${specifier}`).not.toBeNull();
    if (!resolved || seen.has(resolved.path)) continue;
    seen.set(resolved.path, resolved.source);
    queue.push(...localImports(resolved.source));
  }
  return seen;
}

describe('the Edge auth bundle', () => {
  it('reaches the files it is supposed to (the walk is not silently empty)', () => {
    const files = edgeReachableFiles();

    expect(files.has('auth.config.ts')).toBe(true);
    expect(files.has('middleware.ts')).toBe(true);
    // Walked at least one level past the entrypoints, so a broken resolver would show.
    expect(files.has('lib/auth/protected-routes.ts')).toBe(true);
  });

  it('pulls in no Node-only dependency, transitively', () => {
    const offenders: string[] = [];
    for (const [relPath, source] of edgeReachableFiles()) {
      for (const pattern of NODE_ONLY) {
        if (pattern.test(source)) offenders.push(`${relPath} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the claim-by-phone verification out of the Edge, in auth.ts where it belongs', () => {
    const files = edgeReachableFiles();

    // The core opens a DB handle and decrypts with node:crypto. Only its NAME may
    // appear at the edge (the jwt callback's provider branch), never its module.
    expect(files.has('lib/auth/claim-by-phone.ts')).toBe(false);
    expect(files.has('lib/auth/claim-phone-authorize.ts')).toBe(false);
    expect(files.get('auth.config.ts')).toContain('claim-phone');

    const authTs = read('auth.ts') ?? '';
    expect(authTs).toContain('claim-phone-authorize');
  });
});

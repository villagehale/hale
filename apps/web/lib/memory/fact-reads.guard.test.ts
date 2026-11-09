import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-599 · a prompt reads family memory through `factsForContext` (or a helper that
 * applies `audiencePredicate`), so no reply can carry what another adult said in their
 * own 1:1 (decision R7). A direct select from `family_memory_facts` skips that rule.
 * This test fails on any module that selects from the table without being listed here,
 * and each entry says why that module may. Adding one is a deliberate act: the reason
 * is the reviewer's contract that the rows never reach a parent-facing prompt or reply,
 * or that the module applies the audience rule itself.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** A select from the table, by name or through an alias of it, or in raw SQL. */
const DIRECT_READ =
  /\.from\(\s*(?:schema\.)?familyMemoryFacts\s*\)|\$\{schema\.familyMemoryFacts\}|=\s*schema\.familyMemoryFacts\s*;/;

const ALLOWED: Record<string, string> = {
  'apps/worker/src/services/memory-context.ts': 'the helper itself: factsForContext',
  'apps/web/lib/memory/store.ts':
    'recall, forget and correct apply audiencePredicate; the rest read a row’s typing or promote by id, never into a prompt. loadRecommendationMemory has no production caller',
  'apps/web/lib/rights/export-memory.ts': 'the access export applies factHeardBy to every row',
  'apps/web/lib/memory/synthesis.ts':
    'the nightly integrity pass: no model, ids and key shapes only',
  'apps/web/lib/memory/digest.ts':
    'counts by fact type, and the age-based ephemeral retirement; no fact text reaches a prompt',
  'apps/web/lib/memory/aliases.ts': 'builds the alias index from keys; no prompt reads these rows',
  'apps/web/lib/memory/classify-write.ts': 'the corrects-key close, held to the writer’s scope',
  'apps/web/lib/memory/forget.ts': 'retires one fact by id, which the caller already filtered',
  'apps/web/lib/memory/timeline/replay.ts': 'the timeline eval harness, not production',
  'apps/web/lib/care/weekday.ts':
    'the writer-pinned weekday-care logistic, which R7 shares with every adult',
  'apps/web/lib/health/reply.ts':
    'the writer-pinned checkpoint receipt, a suppression predicate; never prompt text',
  'apps/web/lib/channel/coparent/duty/asks.ts': 'the household duty board: logistics, shared by R7',
  'apps/web/lib/channel/coparent/duty/burden.ts':
    'the household duty board: logistics, shared by R7',
  'apps/web/lib/channel/coparent/duty/model.ts':
    'the household duty board: logistics, shared by R7',
  'apps/web/lib/channel/coparent/duty/undo.ts': 'the household duty board: logistics, shared by R7',
  'apps/web/lib/channel/coparent/duty/metrics.ts':
    'Hale’s open duty ask, read for an audit timestamp',
  'apps/web/lib/channel/intake/cold-start/ledger.ts': 'Hale’s own stop-asking record',
  'apps/web/lib/channel/linq/logistics-poll.ts': 'the household logistics poll, shared by R7',
  'apps/web/lib/channel/linq/multi-family.ts':
    'FOLLOW-UP (VIL-599): fact keys feed the group deny list (wants every key) and the private aside (wants a reader); not yet split',
  'apps/worker/src/tools/registry.ts':
    'Reviewer verification tools on namespaced keys; they return booleans, not fact text',
};

const SCAN_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/worker/src',
  'packages',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function directReaders(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      if (DIRECT_READ.test(readFileSync(file, 'utf8')))
        found.push(file.slice(REPO_ROOT.length + 1));
    }
  }
  return found.sort();
}

describe('family memory facts are read through the audience helper', () => {
  it('the detector sees each way a select can be spelled, and not a write', () => {
    expect(DIRECT_READ.test('db.select().from(schema.familyMemoryFacts)')).toBe(true);
    expect(DIRECT_READ.test('.from( familyMemoryFacts )')).toBe(true);
    expect(DIRECT_READ.test('const facts = schema.familyMemoryFacts;')).toBe(true);
    expect(DIRECT_READ.test('sql`select 1 from ${schema.familyMemoryFacts}`')).toBe(true);
    expect(DIRECT_READ.test('tx.update(schema.familyMemoryFacts).set({})')).toBe(false);
  });

  it('no module outside the list selects from family_memory_facts', () => {
    const readers = directReaders();
    // Positive control: the scan reaches the helper, so an empty result is not a blind one.
    expect(readers).toContain('apps/worker/src/services/memory-context.ts');
    expect(readers.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it('every listed module still reads the table, so the list cannot go stale', () => {
    const readers = new Set(directReaders());
    expect(Object.keys(ALLOWED).filter((file) => !readers.has(file))).toEqual([]);
  });
});

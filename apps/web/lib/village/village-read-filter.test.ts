import { describe, expect, it, vi } from 'vitest';

// villageActiveFilter is a pure Drizzle-filter builder, but it lives in queries.ts
// whose import graph reaches ~/lib/family → ~/auth (next-auth). Stub the auth edge
// so this pure-function test doesn't drag the whole auth runtime in.
vi.mock('~/auth', () => ({ auth: () => Promise.resolve(null) }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const { villageActiveFilter } = await import('./queries.js');

/**
 * The read-scoping predicate for the village feed. Default reads the STANDING feed
 * (existing behaviour preserved); a searchSeason reads the latest SEARCH run for
 * that season. Asserted by serializing the Drizzle filter to SQL-ish text so the
 * exact predicate — derived from the coexistence spec, not the query code — is
 * pinned. The family-scope + supersededAt-null gates are always present.
 */

const FAMILY_ID = 'fam-1';

/** Flatten a Drizzle filter's queryChunks to a lowercase SQL-ish string. */
function filterToSql(filter: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if ('queryChunks' in obj) {
        walk(obj.queryChunks);
        return;
      }
      if ('name' in obj && typeof obj.name === 'string') {
        parts.push(obj.name);
        return;
      }
      if ('value' in obj) {
        const v = obj.value;
        if (typeof v === 'string') parts.push(v);
        else if (Array.isArray(v)) parts.push(v.join(''));
        return;
      }
      return;
    }
    if (typeof node === 'string') parts.push(node);
  };
  walk(filter);
  return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('villageActiveFilter', () => {
  it('default: scopes to the family, active rows, and the STANDING feed (or legacy null)', () => {
    const sql = filterToSql(villageActiveFilter(FAMILY_ID));
    expect(sql).toContain('family_id = fam-1');
    expect(sql).toContain('superseded_at is null');
    // Standing feed: run_type standing OR legacy null (backfilled to standing).
    expect(sql).toContain('run_type = standing');
    expect(sql).toContain('run_type is null');
    // A standing read must NOT scope to a search season.
    expect(sql).not.toContain('search_season');
  });

  it('search: scopes to the family, active rows, the SEARCH run type, and the season', () => {
    const sql = filterToSql(villageActiveFilter(FAMILY_ID, { searchSeason: 'fall' }));
    expect(sql).toContain('family_id = fam-1');
    expect(sql).toContain('superseded_at is null');
    expect(sql).toContain('run_type = search');
    expect(sql).toContain('search_season = fall');
    // A search read must NOT also pull the standing feed.
    expect(sql).not.toContain('run_type = standing');
  });
});

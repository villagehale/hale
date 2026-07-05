import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { type DiscoverDeps, type DiscoveryAnthropicClient, discoverForFamily } from './discover.js';

/**
 * Timeframe-search discovery: a season-scoped `search` run must coexist with the
 * standing weekly feed. The critical invariant is CLOBBER-PREVENTION — a search
 * run soft-retires only prior SEARCH rows, a standing run only STANDING rows —
 * so a "find fall activities" search never wipes the weekly feed and vice-versa.
 *
 * These use a STATEFUL fake db that actually holds rows and applies the supersede
 * UPDATE against the family + supersededAt-null + the run_type the code scoped to
 * (read out of the captured Drizzle filter), then inserts the new run. The tests
 * assert the exact supersededAt state of every pre-existing row — derived from the
 * spec's coexistence rule, not copied from the implementation.
 */

const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const TODDLER_DOB = '2024-06-01';

interface Row {
  id: string;
  familyId: string;
  runType: string;
  searchSeason: string | null;
  supersededAt: Date | null;
}

/** Serialize a Drizzle filter's queryChunks to a lowercase SQL-ish string so the
 * fake can read which run_type predicate the supersede UPDATE scoped to (search vs
 * standing) without coupling to Drizzle's private object shape beyond its chunks. */
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
  return parts.join(' ').toLowerCase();
}

/** A stateful fake that stores `rows` and honours the supersede scope. */
function statefulDb(rows: Row[], children: Array<{ dateOfBirth: string; interests: string[] }>) {
  let selectCall = 0;
  const select = vi.fn().mockImplementation(() => {
    const call = selectCall++;
    if (call === 0) {
      return { from: () => ({ where: () => ({ limit: async () => [{ areaCoarse: 'L7G' }] }) }) };
    }
    return { from: () => ({ where: async () => children }) };
  });

  let idSeq = rows.length;
  const tx = {
    insert: (table: unknown) => ({
      values: async (newRows: unknown) => {
        if (table === schema.auditLog) return;
        if (table !== schema.villageCandidates) throw new Error('unexpected insert target');
        const list = (Array.isArray(newRows) ? newRows : [newRows]) as Array<
          Record<string, unknown>
        >;
        for (const r of list) {
          rows.push({
            id: `new-${idSeq++}`,
            familyId: r.familyId as string,
            runType: (r.runType as string) ?? 'standing',
            searchSeason: (r.searchSeason as string | null) ?? null,
            supersededAt: null,
          });
        }
      },
    }),
    update: (table: unknown) => {
      if (table !== schema.villageCandidates) throw new Error('unexpected update target');
      return {
        set: (payload: Record<string, unknown>) => ({
          where: async (filter: unknown) => {
            const sql = filterToSql(filter);
            const wantsSearch = /run_type\s*=\s*search/.test(sql);
            const stamp = payload.supersededAt as Date;
            for (const row of rows) {
              if (row.familyId !== FAMILY_ID) continue;
              if (row.supersededAt !== null) continue;
              const isSearch = row.runType === 'search';
              // Standing scope also matches legacy null run_type (backfilled to
              // 'standing' by the migration, so no null in practice — but the query
              // is written to cover it defensively).
              const matches = wantsSearch ? isSearch : !isSearch;
              if (matches) row.supersededAt = stamp;
            }
          },
        }),
      };
    },
  };

  const transaction = vi.fn().mockImplementation((cb: (t: typeof tx) => Promise<void>) => cb(tx));
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.agentRuns) {
      return { values: () => ({ returning: async () => [{ id: 'run-1' }] }) };
    }
    throw new Error('unexpected top-level insert');
  });
  return { select, transaction, insert } as never;
}

function fakeClient() {
  const create = vi.fn().mockResolvedValue({
    content: [
      {
        type: 'tool_use',
        name: 'submit_candidates',
        input: {
          candidates: [
            { title: 'Fall leaf hike', description: 'x', confidence: 0.7, coverageNote: 'y' },
          ],
        },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  const client = { messages: { create } } as unknown as DiscoveryAnthropicClient;
  return { client, create };
}

function deps(client: DiscoveryAnthropicClient): DiscoverDeps {
  return {
    client,
    loadPrompt: async () => 'SYSTEM',
    loadModel: async () => 'claude-test',
    geocode: async () => null,
    geocodeArea: async () => null,
  };
}

describe('discoverForFamily — timeframe-search coexistence (clobber prevention)', () => {
  it('a SEARCH run supersedes prior search rows but leaves the standing feed untouched', async () => {
    const standing: Row = {
      id: 'standing-1',
      familyId: FAMILY_ID,
      runType: 'standing',
      searchSeason: null,
      supersededAt: null,
    };
    const priorSearch: Row = {
      id: 'search-old',
      familyId: FAMILY_ID,
      runType: 'search',
      searchSeason: 'fall',
      supersededAt: null,
    };
    const rows = [standing, priorSearch];
    const db = statefulDb(rows, [{ dateOfBirth: TODDLER_DOB, interests: ['leaves'] }]);

    await discoverForFamily(FAMILY_ID, db, deps(fakeClient().client), { searchSeason: 'fall' });

    // The standing feed row is NEVER touched by a search run.
    expect(standing.supersededAt).toBeNull();
    // The prior search row IS soft-retired.
    expect(priorSearch.supersededAt).toBeInstanceOf(Date);
    // The new run lands active, tagged as a search for the requested season.
    const fresh = rows.filter((r) => r.id.startsWith('new-'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ runType: 'search', searchSeason: 'fall', supersededAt: null });
  });

  it('a STANDING run supersedes prior standing rows but leaves search rows untouched', async () => {
    const standing: Row = {
      id: 'standing-1',
      familyId: FAMILY_ID,
      runType: 'standing',
      searchSeason: null,
      supersededAt: null,
    };
    const search: Row = {
      id: 'search-1',
      familyId: FAMILY_ID,
      runType: 'search',
      searchSeason: 'fall',
      supersededAt: null,
    };
    const rows = [standing, search];
    const db = statefulDb(rows, [{ dateOfBirth: TODDLER_DOB, interests: ['leaves'] }]);

    // No options → the standing run (existing behaviour).
    await discoverForFamily(FAMILY_ID, db, deps(fakeClient().client));

    // The prior standing row is soft-retired…
    expect(standing.supersededAt).toBeInstanceOf(Date);
    // …but the search run is NEVER clobbered by a standing run.
    expect(search.supersededAt).toBeNull();
    // The new run lands active, tagged as standing with no season.
    const fresh = rows.filter((r) => r.id.startsWith('new-'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ runType: 'standing', searchSeason: null, supersededAt: null });
  });

  it('serializes season_hint into the model input for a search run (reuses the documented input)', async () => {
    const { client, create } = fakeClient();
    const db = statefulDb([], [{ dateOfBirth: TODDLER_DOB, interests: ['leaves'] }]);

    await discoverForFamily(FAMILY_ID, db, deps(client), { searchSeason: 'fall' });

    const sent = JSON.parse(create.mock.calls[0]?.[0]?.messages?.[0]?.content as string);
    expect(sent.season_hint).toBe('fall');
  });

  it('omits season_hint for a standing run', async () => {
    const { client, create } = fakeClient();
    const db = statefulDb([], [{ dateOfBirth: TODDLER_DOB, interests: ['leaves'] }]);

    await discoverForFamily(FAMILY_ID, db, deps(client));

    const sent = JSON.parse(create.mock.calls[0]?.[0]?.messages?.[0]?.content as string);
    expect(sent).not.toHaveProperty('season_hint');
  });
});

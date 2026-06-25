import { describe, expect, it, vi } from 'vitest';

// upsert.ts → ../queries → ~/lib/family → ~/auth pulls the next-auth/next-cache
// chain at import time; stub those edges (the established idiom — see feed.test.ts)
// so the injected-deps unit imports without real infra.
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));

const { upsertFeedRank } = await import('./upsert');
type UpsertFeedRankDeps = import('./upsert').UpsertFeedRankDeps;

/**
 * upsertFeedRank is the BACKGROUND rank materializer the drain runs. The spend
 * guard (rule #7) is the contract under test: the ranker is invoked ONLY when the
 * candidate set changed since the stored row's fingerprint. Deps are injected
 * (loadCandidateIds, the existing row, the ranker, the model resolver, the
 * upsert) so this unit drives the short-circuit/recompute decision without a real
 * db or a real LLM (rule #8 — the LLM is never mocked into the rank eval; here we
 * inject the rank FUNCTION boundary).
 */

const FAMILY = '11111111-1111-1111-1111-111111111111';

function makeDeps(overrides: Partial<UpsertFeedRankDeps>): {
  deps: UpsertFeedRankDeps;
  ranker: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
} {
  const ranker = vi.fn(async () => ({ orderedIds: ['c', 'b', 'a'] }));
  const upsert = vi.fn(async () => undefined);
  const deps: UpsertFeedRankDeps = {
    loadCandidateIds: async () => ['a', 'b', 'c'],
    loadExistingRank: async () => null,
    rank: ranker,
    resolveModel: async () => 'claude-sonnet-4-6',
    upsert,
    ...overrides,
  };
  return { deps, ranker, upsert };
}

describe('upsertFeedRank', () => {
  it('SHORT-CIRCUITS (no model call, no write) when the stored fingerprint matches', async () => {
    const { deps, ranker, upsert } = makeDeps({
      loadCandidateIds: async () => ['a', 'b', 'c'],
      loadExistingRank: async () => ({ fingerprint: 'a,b,c' }),
    });

    const result = await upsertFeedRank({} as never, FAMILY, deps);

    expect(ranker).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(result).toBe('unchanged');
  });

  it('RECOMPUTES (calls the ranker, then upserts) when the candidate set changed', async () => {
    const { deps, ranker, upsert } = makeDeps({
      loadCandidateIds: async () => ['a', 'b', 'c'],
      // Stored row predates a newly discovered candidate.
      loadExistingRank: async () => ({ fingerprint: 'a,b' }),
    });

    const result = await upsertFeedRank({} as never, FAMILY, deps);

    expect(ranker).toHaveBeenCalledTimes(1);
    expect(ranker).toHaveBeenCalledWith(
      { familyId: FAMILY, candidateIds: ['a', 'b', 'c'], actor: 'system' },
      expect.anything(),
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      familyId: FAMILY,
      orderedIds: ['c', 'b', 'a'],
      fingerprint: 'a,b,c',
      modelUsed: 'claude-sonnet-4-6',
    });
    expect(result).toBe('ranked');
  });

  it('RECOMPUTES when there is no stored row yet (cold family)', async () => {
    const { deps, ranker, upsert } = makeDeps({ loadExistingRank: async () => null });

    const result = await upsertFeedRank({} as never, FAMILY, deps);

    expect(ranker).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(result).toBe('ranked');
  });

  it('SKIPS (no model call, no write) when there are fewer than two candidates', async () => {
    const { deps, ranker, upsert } = makeDeps({ loadCandidateIds: async () => ['only-one'] });

    const result = await upsertFeedRank({} as never, FAMILY, deps);

    expect(ranker).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(result).toBe('skipped');
  });
});

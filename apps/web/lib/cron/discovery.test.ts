import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The discovery CRON orchestration: select stale/empty families (bounded), call
 * the EXISTING discoverForFamily for each, aggregate, and keep going past a
 * per-family failure. discoverForFamily's own behaviour (one bounded call,
 * teen-exclusion, self-audit) is covered by village/discover.test.ts — here we
 * stub it to assert the loop wiring.
 */

const discoverForFamilyMock = vi.fn();
const selectFamiliesNeedingDiscoveryMock = vi.fn();

vi.mock('~/lib/village/discover', () => ({
  discoverForFamily: (...a: unknown[]) => discoverForFamilyMock(...a),
  defaultDiscoverDeps: () => ({ client: {}, loadPrompt: async () => '', loadModel: async () => '' }),
}));
vi.mock('./families', () => ({
  MAX_FAMILIES_PER_RUN: { digest: 100, discovery: 50, inference: 100 },
  selectFamiliesNeedingDiscovery: (...a: unknown[]) => selectFamiliesNeedingDiscoveryMock(...a),
  selectFamiliesForRun: vi.fn(),
}));

const DEPS = { client: {}, loadPrompt: async () => '', loadModel: async () => '' } as never;

describe('runDiscoveryCron', () => {
  beforeEach(() => {
    vi.resetModules();
    discoverForFamilyMock.mockReset();
    selectFamiliesNeedingDiscoveryMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs discovery for each stale family, capped by MAX_FAMILIES_PER_RUN.discovery', async () => {
    selectFamiliesNeedingDiscoveryMock.mockResolvedValue(['fam-a', 'fam-b']);
    discoverForFamilyMock
      .mockResolvedValueOnce({ status: 'discovered', insertedCount: 3 })
      .mockResolvedValueOnce({ status: 'no_non_teen_children' });

    const { runDiscoveryCron } = await import('./discovery');
    const summary = await runDiscoveryCron({} as never, DEPS);

    // Bounded by the discovery cap.
    expect(selectFamiliesNeedingDiscoveryMock).toHaveBeenCalledWith({}, 50, expect.any(Date));
    expect(discoverForFamilyMock).toHaveBeenCalledTimes(2);
    expect(summary.processed).toBe(2);
    expect(summary.results).toEqual([
      { familyId: 'fam-a', result: { status: 'discovered', insertedCount: 3 } },
      { familyId: 'fam-b', result: { status: 'no_non_teen_children' } },
    ]);
  });

  it('records a per-family failure and continues the batch', async () => {
    selectFamiliesNeedingDiscoveryMock.mockResolvedValue(['fam-a', 'fam-b']);
    discoverForFamilyMock
      .mockRejectedValueOnce(new Error('model timeout'))
      .mockResolvedValueOnce({ status: 'discovered', insertedCount: 1 });

    const { runDiscoveryCron } = await import('./discovery');
    const summary = await runDiscoveryCron({} as never, DEPS);

    expect(discoverForFamilyMock).toHaveBeenCalledTimes(2);
    expect(summary.results).toEqual([
      { familyId: 'fam-a', error: 'model timeout' },
      { familyId: 'fam-b', result: { status: 'discovered', insertedCount: 1 } },
    ]);
  });
});

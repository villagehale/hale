import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Request-level rehydration for the continuous-companion shell: a server component
 * asks for the current family's ONE ongoing conversation, its children (the focus
 * chips), and stage-aware suggestions to seed the UI on load. Family resolution +
 * db + children are the request edges (stubbed here); this asserts they're wired so
 * a refresh replays the timeline and the chips/suggestions reflect the family.
 */

const currentFamilyIdMock = vi.fn();
const loadLatestThreadMock = vi.fn();
const childRows: Array<{ id: string; name: string; dateOfBirth: string }> = [];

vi.mock('~/lib/family', () => ({ currentFamilyId: () => currentFamilyIdMock() }));
vi.mock('~/lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: async () => childRows }) }),
  }),
}));
vi.mock('./conversation', () => ({
  loadLatestThread: (...a: unknown[]) => loadLatestThreadMock(...a),
}));

describe('loadThreadShellForRequest', () => {
  beforeEach(() => {
    vi.resetModules();
    currentFamilyIdMock.mockReset();
    loadLatestThreadMock.mockReset();
    childRows.length = 0;
    // The loader returns the empty seed without a DB; these cases exercise the
    // DB-present path, so a value is stubbed.
    vi.stubEnv('DATABASE_URL', 'postgres://test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an empty shell in credential-less preview (no DATABASE_URL)', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { loadThreadShellForRequest } = await import('./thread');

    const seed = await loadThreadShellForRequest();

    expect(seed.conversationId).toBeNull();
    expect(seed.timeline).toEqual([]);
    expect(currentFamilyIdMock).not.toHaveBeenCalled();
  });

  it('returns an empty shell when no family resolves (signed-out / onboarding)', async () => {
    currentFamilyIdMock.mockResolvedValue(null);
    const { loadThreadShellForRequest } = await import('./thread');

    const seed = await loadThreadShellForRequest();

    expect(seed.conversationId).toBeNull();
    expect(seed.timeline).toEqual([]);
    expect(seed.children).toEqual([]);
    // The family default suggestion group is always present.
    expect(seed.suggestions.some((g) => g.childId === null)).toBe(true);
    expect(loadLatestThreadMock).not.toHaveBeenCalled();
  });

  it('rehydrates the family timeline + builds focus chips and stage-aware suggestions', async () => {
    currentFamilyIdMock.mockResolvedValue('fam-1');
    childRows.push(
      { id: 'tot', name: 'Mara', dateOfBirth: '2024-05-01' },
      { id: 'teen', name: 'Eli', dateOfBirth: '2010-01-01' },
    );
    loadLatestThreadMock.mockResolvedValue({
      conversationId: 'conv-9',
      timeline: [
        { id: 'm0', role: 'user', content: 'is this normal?', childId: 'tot', topic: 'sleep', createdAt: 't0' },
      ],
    });
    const { loadThreadShellForRequest } = await import('./thread');

    const seed = await loadThreadShellForRequest();

    expect(seed.conversationId).toBe('conv-9');
    expect(seed.timeline).toHaveLength(1);

    // Focus chips carry each child by NAME — including the teen (policy 1: the
    // parent named them, and two teens must never both read "your teen"). The
    // teenRedacted flag still marks the teen for downstream CONTENT gating.
    const tot = seed.children.find((c) => c.id === 'tot');
    const teen = seed.children.find((c) => c.id === 'teen');
    expect(tot?.label).toBe('Mara');
    expect(teen?.label).toBe('Eli');
    expect(teen?.teenRedacted).toBe(true);

    // Stage-aware suggestions: a per-child group exists for each child + a family default.
    expect(seed.suggestions.find((g) => g.childId === 'tot')?.stage).toBe('toddler');
    expect(seed.suggestions.find((g) => g.childId === 'teen')?.stage).toBe('teenager');
  });

  it('returns an empty timeline when the family has no conversation yet', async () => {
    currentFamilyIdMock.mockResolvedValue('fam-1');
    loadLatestThreadMock.mockResolvedValue(null);
    const { loadThreadShellForRequest } = await import('./thread');

    const seed = await loadThreadShellForRequest();

    expect(seed.conversationId).toBeNull();
    expect(seed.timeline).toEqual([]);
  });
});

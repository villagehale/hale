import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Request-level rehydration for Ask Hale: a server component asks for the current
 * family's latest thread to seed the UI on load. Family resolution + db are the
 * request edges (stubbed here); this asserts they're wired so a refresh replays
 * persisted history, and that no family resolves to an empty (not crashing) UI.
 */

const currentFamilyIdMock = vi.fn();
const loadLatestThreadMock = vi.fn();

vi.mock('~/lib/family', () => ({ currentFamilyId: () => currentFamilyIdMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('./conversation', () => ({
  loadLatestThread: (...a: unknown[]) => loadLatestThreadMock(...a),
}));

describe('loadLatestThreadForRequest', () => {
  beforeEach(() => {
    vi.resetModules();
    currentFamilyIdMock.mockReset();
    loadLatestThreadMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an empty thread when no family resolves (signed-out / onboarding)', async () => {
    currentFamilyIdMock.mockResolvedValue(null);
    const { loadLatestThreadForRequest } = await import('./thread');

    const thread = await loadLatestThreadForRequest();

    expect(thread).toEqual({ conversationId: null, messages: [] });
    expect(loadLatestThreadMock).not.toHaveBeenCalled();
  });

  it('rehydrates the family latest thread when one exists', async () => {
    currentFamilyIdMock.mockResolvedValue('fam-1');
    loadLatestThreadMock.mockResolvedValue({
      conversationId: 'conv-9',
      messages: [
        { role: 'user', content: 'is this normal?' },
        { role: 'assistant', content: 'yes — very common at this age.' },
      ],
    });
    const { loadLatestThreadForRequest } = await import('./thread');

    const thread = await loadLatestThreadForRequest();

    expect(thread).toEqual({
      conversationId: 'conv-9',
      messages: [
        { role: 'user', content: 'is this normal?' },
        { role: 'assistant', content: 'yes — very common at this age.' },
      ],
    });
  });

  it('returns an empty thread when the family has no conversation yet', async () => {
    currentFamilyIdMock.mockResolvedValue('fam-1');
    loadLatestThreadMock.mockResolvedValue(null);
    const { loadLatestThreadForRequest } = await import('./thread');

    const thread = await loadLatestThreadForRequest();

    expect(thread).toEqual({ conversationId: null, messages: [] });
  });
});

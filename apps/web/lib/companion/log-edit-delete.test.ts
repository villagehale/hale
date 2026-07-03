import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * editQuickEpisode / deleteQuickEpisode server actions. They resolve the family
 * AND the acting user at request time (the audit actor is the parent, rule #6),
 * then delegate to the family-scoped updateEpisode / softDeleteEpisode helpers.
 * A helper returning false (a foreign episode not in the family) surfaces as
 * 'forbidden' and never claims success (rule #1). Edges (auth/db/family/user) are
 * stubbed so the tests exercise validation + gating, not infra.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EPISODE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-06-30T12:00:00Z');

const familyMock = vi.fn();
const userMock = vi.fn();
const updateEpisodeMock = vi.fn();
const softDeleteEpisodeMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/auth', () => ({ auth: () => Promise.resolve({ user: { id: 'ext-google-sub' } }) }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => familyMock(),
  resolveUserIdForUser: () => userMock(),
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateMock(p) }));
vi.mock('./log-write.js', async () => {
  const actual = await vi.importActual<typeof import('./log-write.js')>('./log-write.js');
  return {
    ...actual,
    updateEpisode: (...args: unknown[]) => updateEpisodeMock(...args),
    softDeleteEpisode: (...args: unknown[]) => softDeleteEpisodeMock(...args),
  };
});

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

beforeEach(() => {
  vi.resetModules();
  familyMock.mockReset();
  userMock.mockReset();
  updateEpisodeMock.mockReset();
  softDeleteEpisodeMock.mockReset();
  revalidateMock.mockReset();
  configureAuth(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('editQuickEpisode', () => {
  it('rejects an empty summary before any write', async () => {
    const { editQuickEpisode } = await import('./log.js');

    const result = await editQuickEpisode({ id: EPISODE_ID, summary: '   ' });

    expect(result.status).toBe('invalid');
    expect(updateEpisodeMock).not.toHaveBeenCalled();
  });

  it('edits and revalidates, passing the acting user as the audit actor (rule #6)', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    userMock.mockResolvedValue(USER_ID);
    updateEpisodeMock.mockResolvedValue(true);
    const { editQuickEpisode } = await import('./log.js');

    const result = await editQuickEpisode({ id: EPISODE_ID, summary: 'Fed 150 ml' }, NOW);

    expect(result.status).toBe('edited');
    expect(updateEpisodeMock).toHaveBeenCalledTimes(1);
    const [, id, familyId, patch, actor] = updateEpisodeMock.mock.calls[0] as unknown[];
    expect(id).toBe(EPISODE_ID);
    expect(familyId).toBe(FAMILY_ID);
    expect(actor).toBe(USER_ID);
    expect(patch).toMatchObject({ summary: 'Fed 150 ml' });
    expect(revalidateMock).toHaveBeenCalledWith('/companion');
  });

  it("forbids editing a foreign episode (helper returns false) — never claims success (rule #1)", async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    userMock.mockResolvedValue(USER_ID);
    updateEpisodeMock.mockResolvedValue(false);
    const { editQuickEpisode } = await import('./log.js');

    const result = await editQuickEpisode({ id: EPISODE_ID, summary: 'hijack' }, NOW);

    expect(result.status).toBe('forbidden');
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('returns preview without writing when no family resolves', async () => {
    familyMock.mockResolvedValue(null);
    const { editQuickEpisode } = await import('./log.js');

    const result = await editQuickEpisode({ id: EPISODE_ID, summary: 'x' });

    expect(result.status).toBe('preview');
    expect(updateEpisodeMock).not.toHaveBeenCalled();
  });
});

describe('deleteQuickEpisode', () => {
  it('soft-deletes and revalidates, passing the acting user as the audit actor', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    userMock.mockResolvedValue(USER_ID);
    softDeleteEpisodeMock.mockResolvedValue(true);
    const { deleteQuickEpisode } = await import('./log.js');

    const result = await deleteQuickEpisode({ id: EPISODE_ID }, NOW);

    expect(result.status).toBe('deleted');
    const [, id, familyId, actor] = softDeleteEpisodeMock.mock.calls[0] as unknown[];
    expect(id).toBe(EPISODE_ID);
    expect(familyId).toBe(FAMILY_ID);
    expect(actor).toBe(USER_ID);
    expect(revalidateMock).toHaveBeenCalledWith('/companion');
  });

  it('forbids deleting a foreign episode (helper returns false) (rule #1)', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    userMock.mockResolvedValue(USER_ID);
    softDeleteEpisodeMock.mockResolvedValue(false);
    const { deleteQuickEpisode } = await import('./log.js');

    const result = await deleteQuickEpisode({ id: EPISODE_ID }, NOW);

    expect(result.status).toBe('forbidden');
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id before any write', async () => {
    const { deleteQuickEpisode } = await import('./log.js');

    const result = await deleteQuickEpisode({ id: 'not-a-uuid' });

    expect(result.status).toBe('invalid');
    expect(softDeleteEpisodeMock).not.toHaveBeenCalled();
  });
});

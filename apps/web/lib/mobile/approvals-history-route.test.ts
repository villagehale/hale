import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Approvals History route returns loadResolvedActions() verbatim; a 13+
// child's raw payload is already redacted inside the loader (rule #1). Read-only.
const authMock = vi.fn();
const loadResolvedActionsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadResolvedActions: () => loadResolvedActionsMock(),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile approvals history route must NOT touch the database (rule #1)');
    },
  };
});

const HISTORY = [
  {
    id: 'action-1',
    actionType: 'reply_to_email',
    summary: 'verified by the reviewer — ready for your approval',
    preview: 'Reply to Dr. Chen — confirm Tuesday',
    payload: { to: 'Dr. Chen' },
    childId: null,
    childLabel: null,
    verdict: 'approved',
    draftedAt: 'Jul 1, 14:00',
    teenRedacted: false,
    status: 'executed',
    resolvedAt: 'Jul 1, 15:00',
  },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/approvals/history/route');
  return GET();
}

describe('GET /api/mobile/approvals/history', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadResolvedActionsMock.mockReset();
    loadResolvedActionsMock.mockResolvedValue(HISTORY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loader', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadResolvedActionsMock).not.toHaveBeenCalled();
  });

  it('returns the resolved-actions history for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ history: HISTORY });
    expect(loadResolvedActionsMock).toHaveBeenCalledTimes(1);
  });
});

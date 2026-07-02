import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Approvals route returns loadPendingApprovals() verbatim; the drafted
// payload is already redacted for a 13+ child's action inside the loader. The
// approve/decline WRITES reuse the existing /api/actions/:id routes (Bearer-callable
// via the middleware bridge), so this route is read-only.
const authMock = vi.fn();
const loadPendingApprovalsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadPendingApprovals: () => loadPendingApprovalsMock(),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile approvals route must NOT touch the database (rule #1)');
    },
  };
});

const APPROVALS = [
  {
    id: 'action-1',
    actionType: 'reply_to_email',
    summary: 'verified by the reviewer — ready for your approval',
    preview: 'Reply to Dr. Chen — confirm Tuesday',
    payload: { to: 'Dr. Chen' },
    verdict: 'approved',
    draftedAt: 'Jul 1, 14:00',
  },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/approvals/route');
  return GET();
}

describe('GET /api/mobile/approvals', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadPendingApprovalsMock.mockReset();
    loadPendingApprovalsMock.mockResolvedValue(APPROVALS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loader', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadPendingApprovalsMock).not.toHaveBeenCalled();
  });

  it('returns the pending approvals queue for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: APPROVALS });
    expect(loadPendingApprovalsMock).toHaveBeenCalledTimes(1);
  });
});

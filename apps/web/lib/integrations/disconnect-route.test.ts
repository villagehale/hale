import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disconnect route's honesty contract: it must surface revokeConnection's row
 * count. The old handler returned {status:'revoked'} regardless — a caller whose
 * (family,user,provider) matched nothing (e.g. a co-parent disconnecting the other
 * parent's connection) saw success while nothing was revoked. Same edge-stub
 * pattern as callback-route.test.ts.
 */
const authMock = vi.fn();
const revokeMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
  resolveUserIdForUser: vi.fn(async () => '22222222-2222-4222-8222-222222222222'),
}));
vi.mock('~/lib/integrations/store', () => ({
  revokeConnection: (...a: unknown[]) => revokeMock(...a),
}));

async function callDisconnect(provider: string) {
  const { POST } = await import('~/app/api/integrations/[provider]/disconnect/route');
  return POST(
    new Request(`http://localhost/api/integrations/${provider}/disconnect`, {
      method: 'POST',
    }) as never,
    { params: Promise.resolve({ provider }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'ext-auth-id' } });
});

describe('POST /api/integrations/[provider]/disconnect', () => {
  it('returns revoked when a row actually matched', async () => {
    revokeMock.mockResolvedValue(1);
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'revoked', provider: 'gcal' });
  });

  it('returns not_found when nothing was the caller’s to disconnect — never a false success', async () => {
    revokeMock.mockResolvedValue(0);
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

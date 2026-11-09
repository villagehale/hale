import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disconnect route's honesty contract: it must surface whether disconnectGoogle
 * ended anything. The old handler returned {status:'revoked'} regardless — a caller whose
 * (family,user,provider) matched nothing (e.g. a co-parent disconnecting the other
 * parent's connection) saw success while nothing was revoked. Same edge-stub
 * pattern as callback-route.test.ts.
 */
const authMock = vi.fn();
const disconnectMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
  resolveUserIdForUser: vi.fn(async () => '22222222-2222-4222-8222-222222222222'),
}));
vi.mock('~/lib/integrations/google-disconnect', () => ({
  disconnectGoogle: (...a: unknown[]) => disconnectMock(...a),
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
  it('returns revoked, every connector it ended, and what Google answered', async () => {
    disconnectMock.mockResolvedValue({
      status: 'disconnected',
      providers: ['gcal', 'gmail'],
      google: 'revoked',
    });
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'revoked',
      provider: 'gcal',
      providers: ['gcal', 'gmail'],
      google: 'revoked',
    });
    expect(disconnectMock).toHaveBeenCalledWith(
      {},
      {
        familyId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        via: 'settings',
        named: 'gcal',
      },
    );
  });

  it('returns not_found when nothing was the caller’s to disconnect — never a false success', async () => {
    disconnectMock.mockResolvedValue({ status: 'not_connected' });
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readClient = vi.fn();
const createCode = vi.fn();
const authMock = vi.fn();
const resolveFamily = vi.fn();
const resolveUser = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...args: unknown[]) => resolveFamily(...args),
  resolveUserIdForUser: (...args: unknown[]) => resolveUser(...args),
}));
vi.mock('~/lib/mcp/oauth-store', () => ({
  readMcpOauthClient: (...args: unknown[]) => readClient(...args),
  createMcpAuthorizationCode: (...args: unknown[]) => createCode(...args),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(null),
}));

const ORIGIN = 'https://hale.example';
const CLIENT = {
  clientId: 'hale_client_test',
  clientName: 'Example assistant',
  redirectUris: ['https://assistant.example/callback'],
};

function form(overrides: Record<string, string | string[]> = {}): URLSearchParams {
  const values: Record<string, string | string[]> = {
    response_type: 'code',
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0] as string,
    resource: `${ORIGIN}/api/mcp`,
    requested_scope: 'events.read actions.propose',
    state: 'opaque-state',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    decision: 'approve',
    granted_scope: ['events.read', 'actions.propose'],
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
  }
  return params;
}

async function call(body: URLSearchParams, origin = ORIGIN): Promise<Response> {
  const { POST } = await import('~/app/api/oauth/authorize/route');
  return POST(
    new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin,
      },
      body,
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('APP_URL', ORIGIN);
  readClient.mockReset().mockResolvedValue(CLIENT);
  createCode.mockReset().mockResolvedValue('hale_code_test');
  authMock.mockReset().mockResolvedValue({ user: { id: 'external-user' } });
  resolveFamily.mockReset().mockResolvedValue('family-id');
  resolveUser.mockReset().mockResolvedValue('user-id');
});

describe('POST /api/oauth/authorize', () => {
  it('rejects a cross-origin form before reading a client or minting a code', async () => {
    const response = await call(form(), 'https://evil.example');

    expect(response.status).toBe(403);
    expect(readClient).not.toHaveBeenCalled();
    expect(createCode).not.toHaveBeenCalled();
  });

  it('never redirects to an unregistered callback', async () => {
    const response = await call(form({ redirect_uri: 'https://evil.example/callback' }));

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(createCode).not.toHaveBeenCalled();
  });

  it('mints only the scopes the signed-in parent selected and returns state', async () => {
    const response = await call(form({ granted_scope: ['events.read'] }));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe(CLIENT.redirectUris[0]);
    expect(location.searchParams.get('code')).toBe('hale_code_test');
    expect(location.searchParams.get('state')).toBe('opaque-state');
    expect(createCode).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        familyId: 'family-id',
        userId: 'user-id',
        scopes: ['events.read'],
      }),
    );
  });

  it('returns a standard access_denied redirect without minting a code', async () => {
    const response = await call(form({ decision: 'deny' }));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('opaque-state');
    expect(createCode).not.toHaveBeenCalled();
  });
});

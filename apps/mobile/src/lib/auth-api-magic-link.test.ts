import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client so importing auth-api.ts doesn't pull in expo-constants (no
// native runtime here). requestMagicLink is asserted against this mocked api();
// verifyMagicLink uses the real fetch-direct exchange() with this API_BASE.
vi.mock('./api-client', () => ({
  api: vi.fn(),
  API_BASE: 'https://api.test',
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { api } from './api-client';
import { requestMagicLink, verifyMagicLink } from './auth-api';

const apiMock = vi.mocked(api);

describe('requestMagicLink', () => {
  beforeEach(() => apiMock.mockReset());

  it('POSTs the email to the mobile magic-link request endpoint', async () => {
    apiMock.mockResolvedValue({ status: 'sent' });
    await requestMagicLink('parent@example.com');
    expect(apiMock).toHaveBeenCalledWith('/api/mobile/auth/magic-link/request', {
      method: 'POST',
      body: JSON.stringify({ email: 'parent@example.com' }),
    });
  });

  it('resolves to { status: "sent" } even for an unknown address (enumeration-safe)', async () => {
    apiMock.mockResolvedValue({ status: 'sent' });
    await expect(requestMagicLink('nobody@example.com')).resolves.toEqual({ status: 'sent' });
  });
});

describe('verifyMagicLink', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the token to the verify endpoint and returns the minted bearer', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: 'bearer.jwt' }), { status: 200 }),
    );
    await expect(verifyMagicLink('good-token')).resolves.toEqual({ token: 'bearer.jwt' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/mobile/auth/magic-link/verify');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'good-token' });
  });

  it('throws a generic error on a 401 (expired / consumed / unknown — never reveals which)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }),
    );
    await expect(verifyMagicLink('stale-token')).rejects.toThrow(/didn't work/);
  });

  it('throws when a 200 body carries no token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(verifyMagicLink('weird')).rejects.toThrow();
  });
});

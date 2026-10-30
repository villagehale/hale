import { afterEach, describe, expect, it, vi } from 'vitest';

describe('POST /api/signup/provider-session', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('refuses when auth is not configured', async () => {
    vi.resetModules();
    vi.doMock('~/lib/auth-config', () => ({ authConfigured: () => false }));
    vi.doMock('~/auth', () => ({ auth: async () => null }));
    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://app.example.com/api/signup/provider-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerHost: 'harbor-rec.example',
          storageState: { cookies: [{ name: 'JSESSIONID', value: 'x', domain: 'harbor-rec.example' }] },
        }),
      }),
    );
    expect(response.status).toBe(501);
  });

  it('refuses a signed-out caller', async () => {
    vi.resetModules();
    vi.doMock('~/lib/auth-config', () => ({ authConfigured: () => true }));
    vi.doMock('~/auth', () => ({ auth: async () => null }));
    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://app.example.com/api/signup/provider-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerHost: 'harbor-rec.example',
          storageState: { cookies: [{ name: 'JSESSIONID', value: 'x', domain: 'harbor-rec.example' }] },
        }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

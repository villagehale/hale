import { afterEach, describe, expect, it, vi } from 'vitest';

describe('POST /api/demo/signup-test/login', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('404s in production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://app.example.com/api/demo/signup-test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a@b.test&password=x',
      }),
    );
    expect(response.status).toBe(404);
  });
});

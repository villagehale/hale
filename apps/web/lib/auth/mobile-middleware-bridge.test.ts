import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The middleware is wrapped by Auth.js's auth(); mock NextAuth so auth() just
// returns the callback, letting the test drive the middleware body directly with a
// fake request. Cookie / session auth is the only remaining path — the Expo
// Authorization: Bearer rewrite is gone (VIL-318).
vi.mock('next-auth', () => ({
  default: () => ({ auth: (cb: unknown) => cb }),
}));
vi.mock('~/auth.config', () => ({ authConfig: {} }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));

type FakeReq = {
  headers: Headers;
  nextUrl: URL;
  cookies: { get: (name: string) => { value: string } | undefined };
  auth?: unknown;
};

function fakeReq(opts: {
  pathname: string;
  headers?: Record<string, string>;
  auth?: unknown;
}): FakeReq {
  return {
    headers: new Headers(opts.headers ?? {}),
    nextUrl: new URL(`https://app.hale.test${opts.pathname}`),
    cookies: { get: () => undefined },
    auth: opts.auth,
  };
}

async function loadMiddleware(): Promise<(req: FakeReq) => Promise<Response> | Response> {
  const mod = await import('~/middleware');
  return mod.default as unknown as (req: FakeReq) => Promise<Response> | Response;
}

describe('middleware cookie / session auth (no Bearer bridge)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does NOT rewrite cookies for an /api request that carries Authorization: Bearer', async () => {
    const middleware = await loadMiddleware();
    const { NextResponse } = await import('next/server');
    const nextSpy = vi.spyOn(NextResponse, 'next');

    await middleware(
      fakeReq({
        pathname: '/api/village/preview',
        headers: { authorization: 'Bearer tok-abc.def', 'x-forwarded-proto': 'https' },
      }),
    );

    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(nextSpy.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('does NOT rewrite headers for a browser /api request with no Authorization', async () => {
    const middleware = await loadMiddleware();
    const { NextResponse } = await import('next/server');
    const nextSpy = vi.spyOn(NextResponse, 'next');

    await middleware(fakeReq({ pathname: '/api/village/preview' }));

    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(nextSpy.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('lets an unauthenticated /api request fall through (no /sign-in redirect)', async () => {
    const middleware = await loadMiddleware();
    const { NextResponse } = await import('next/server');
    const redirectSpy = vi.spyOn(NextResponse, 'redirect');

    await middleware(fakeReq({ pathname: '/api/village/preview', auth: null }));

    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it('still redirects an unauthenticated protected page to /sign-in (no regression)', async () => {
    const middleware = await loadMiddleware();
    const { NextResponse } = await import('next/server');
    const redirectSpy = vi.spyOn(NextResponse, 'redirect');

    await middleware(fakeReq({ pathname: '/home', auth: null }));

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    const target = redirectSpy.mock.calls[0]?.[0] as URL;
    expect(target.pathname).toBe('/sign-in');
  });
});

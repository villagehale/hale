import { getToken } from 'next-auth/jwt';
import { beforeAll, describe, expect, it } from 'vitest';
import { bridgeBearerToSessionCookie } from './bearer-bridge';
import { mintMobileSessionToken } from './mobile-token';

const TEST_SECRET = 'test-auth-secret-bearer-bridge-0123456789abcdef00';

const SECURE_COOKIE = '__Secure-authjs.session-token';
const INSECURE_COOKIE = 'authjs.session-token';

beforeAll(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
});

/** Build the bridge input from a raw header map. */
function input(opts: {
  pathname: string;
  secure: boolean;
  headers: Record<string, string>;
}): { headers: Headers; pathname: string; secure: boolean } {
  return {
    pathname: opts.pathname,
    secure: opts.secure,
    headers: new Headers(opts.headers),
  };
}

describe('bridgeBearerToSessionCookie', () => {
  it('emits the secure cookie name for a secure /api Bearer request', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/village/preview',
        secure: true,
        headers: { authorization: 'Bearer tok123' },
      }),
    );
    expect(result).toEqual({ cookieHeader: `${SECURE_COOKIE}=tok123` });
  });

  it('emits the insecure cookie name for an insecure /api Bearer request', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/village/preview',
        secure: false,
        headers: { authorization: 'Bearer tok123' },
      }),
    );
    expect(result).toEqual({ cookieHeader: `${INSECURE_COOKIE}=tok123` });
  });

  it('returns null for a non-/api path even with a valid Bearer token', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/home',
        secure: true,
        headers: { authorization: 'Bearer tok123' },
      }),
    );
    expect(result).toBeNull();
  });

  it('returns null when there is no Authorization header', () => {
    const result = bridgeBearerToSessionCookie(
      input({ pathname: '/api/x', secure: true, headers: {} }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/x',
        secure: true,
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a bare "Bearer" with no token', () => {
    const result = bridgeBearerToSessionCookie(
      input({ pathname: '/api/x', secure: true, headers: { authorization: 'Bearer' } }),
    );
    expect(result).toBeNull();
  });

  it('returns null for "Bearer a b" (extra token segment)', () => {
    const result = bridgeBearerToSessionCookie(
      input({ pathname: '/api/x', secure: true, headers: { authorization: 'Bearer a b' } }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a token containing a semicolon (cookie injection)', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/x',
        secure: true,
        headers: { authorization: 'Bearer tok;other=1' },
      }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a token containing CRLF (header injection)', () => {
    // A CRLF can't survive `new Headers()` (the WHATWG guard rejects it at
    // construction), so feed the raw header value through a Headers-shaped stub to
    // prove the charset guard itself refuses CR/LF.
    const rawHeaders = {
      get: (k: string) => (k === 'authorization' ? 'Bearer tok\r\nX-Injected: 1' : null),
    };
    const result = bridgeBearerToSessionCookie({
      pathname: '/api/x',
      secure: true,
      headers: rawHeaders as unknown as Headers,
    });
    expect(result).toBeNull();
  });

  it('returns null for a token containing a space (header stub bypassing Headers guard)', () => {
    const rawHeaders = {
      get: (k: string) => (k === 'authorization' ? 'Bearer tok with space' : null),
    };
    const result = bridgeBearerToSessionCookie({
      pathname: '/api/x',
      secure: true,
      headers: rawHeaders as unknown as Headers,
    });
    expect(result).toBeNull();
  });

  it('does not override an existing session cookie (secure)', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/x',
        secure: true,
        headers: {
          authorization: 'Bearer tok123',
          cookie: `${SECURE_COOKIE}=browser-session`,
        },
      }),
    );
    expect(result).toBeNull();
  });

  it('does not override an existing session cookie (insecure)', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/x',
        secure: false,
        headers: {
          authorization: 'Bearer tok123',
          cookie: `${INSECURE_COOKIE}=browser-session`,
        },
      }),
    );
    expect(result).toBeNull();
  });

  it('preserves other cookies when composing the session cookie', () => {
    const result = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/x',
        secure: true,
        headers: {
          authorization: 'Bearer tok123',
          cookie: 'hale_invite=abc; theme=dark',
        },
      }),
    );
    expect(result).toEqual({
      cookieHeader: `hale_invite=abc; theme=dark; ${SECURE_COOKIE}=tok123`,
    });
  });

  it('round-trips a real minted token: the bridged cookie is exactly what getToken reads', async () => {
    const sub = 'credentials:round-trip-1';
    const token = await mintMobileSessionToken({
      sub,
      email: 'rt@hale.test',
      secureRequest: true,
    });

    const bridged = bridgeBearerToSessionCookie(
      input({
        pathname: '/api/anything',
        secure: true,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(bridged).not.toBeNull();

    const req = new Request('https://x/api/anything', {
      headers: { cookie: (bridged as { cookieHeader: string }).cookieHeader },
    });
    const decoded = await getToken({ req, secret: TEST_SECRET, secureCookie: true });

    expect(decoded?.sub).toBe(sub);
    expect(decoded?.email).toBe('rt@hale.test');
  });
});

import { getToken } from 'next-auth/jwt';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MOBILE_SESSION_MAX_AGE_S,
  mintMobileSessionToken,
  requestIsSecure,
} from './mobile-token';

// A fixed secret so mint and read derive the same encryption key. This is the
// AUTH_SECRET the minter reads and getToken() verifies against.
const TEST_SECRET = 'test-auth-secret-mobile-token-0123456789abcdef';

beforeAll(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
});

function bearerRequest(url: string, token: string): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

describe('mintMobileSessionToken', () => {
  it('round-trips sub and email under the secure salt', async () => {
    const token = await mintMobileSessionToken({
      sub: 'credentials:test-cred-1',
      email: 'secure@hale.test',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe('credentials:test-cred-1');
    expect(decoded?.email).toBe('secure@hale.test');
  });

  it('round-trips sub and email under the insecure salt', async () => {
    const token = await mintMobileSessionToken({
      sub: 'google-oauth-sub-42',
      email: 'plain@hale.test',
      secureRequest: false,
    });

    const decoded = await getToken({
      req: bearerRequest('http://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: false,
    });

    expect(decoded?.sub).toBe('google-oauth-sub-42');
    expect(decoded?.email).toBe('plain@hale.test');
  });

  it('omits the email claim entirely when no email is provided (sub still round-trips)', async () => {
    const token = await mintMobileSessionToken({
      sub: 'google-oauth-sub-no-email',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe('google-oauth-sub-no-email');
    expect(decoded).not.toHaveProperty('email');
  });

  it('round-trips the profile picture as the standard `picture` claim (→ session.user.image on the Bearer path)', async () => {
    const token = await mintMobileSessionToken({
      sub: 'google-oauth-sub-42',
      email: 'plain@hale.test',
      picture: 'https://lh3.googleusercontent.com/a/photo',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.picture).toBe('https://lh3.googleusercontent.com/a/photo');
  });

  it('omits the picture claim entirely when no picture is provided', async () => {
    const token = await mintMobileSessionToken({
      sub: 'google-oauth-sub-42',
      email: 'plain@hale.test',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded).not.toHaveProperty('picture');
  });

  it('fails to decode across salts (secure mint, insecure read)', async () => {
    const token = await mintMobileSessionToken({
      sub: 'credentials:test-cred-1',
      email: 'secure@hale.test',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('http://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: false,
    });

    expect(decoded).toBeNull();
  });

  it('fails to decode with the wrong secret', async () => {
    const token = await mintMobileSessionToken({
      sub: 'credentials:test-cred-1',
      email: 'secure@hale.test',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: 'a-totally-different-secret-that-should-not-decode',
      secureCookie: true,
    });

    expect(decoded).toBeNull();
  });

  it('honors the 7-day expiry exactly (exp - iat)', async () => {
    const token = await mintMobileSessionToken({
      sub: 'credentials:test-cred-1',
      email: 'secure@hale.test',
      secureRequest: true,
    });

    const decoded = await getToken({
      req: bearerRequest('https://x/api/anything', token),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded).not.toBeNull();
    const { exp, iat } = decoded as { exp: number; iat: number };
    expect(exp - iat).toBe(7 * 24 * 60 * 60);
    expect(MOBILE_SESSION_MAX_AGE_S).toBe(7 * 24 * 60 * 60);
  });

  it('throws when AUTH_SECRET is unset (no masking)', async () => {
    const saved = process.env.AUTH_SECRET;
    // Empty string, not `undefined`: assigning undefined to a process.env key
    // coerces to the truthy string "undefined", which would slip past the guard.
    process.env.AUTH_SECRET = '';
    try {
      await expect(
        mintMobileSessionToken({
          sub: 'credentials:test-cred-1',
          email: 'secure@hale.test',
          secureRequest: true,
        }),
      ).rejects.toThrow('AUTH_SECRET is not set');
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });
});

describe('requestIsSecure', () => {
  it('is true for x-forwarded-proto https', () => {
    expect(requestIsSecure(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
  });

  it('is false for x-forwarded-proto http', () => {
    expect(requestIsSecure(new Headers({ 'x-forwarded-proto': 'http' }))).toBe(false);
  });

  it('is false when x-forwarded-proto is missing', () => {
    expect(requestIsSecure(new Headers())).toBe(false);
  });

  it('reads the first value of a comma-separated proto list', () => {
    expect(requestIsSecure(new Headers({ 'x-forwarded-proto': 'https,http' }))).toBe(true);
  });
});

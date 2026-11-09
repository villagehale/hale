import { describe, expect, it } from 'vitest';
import { GOOGLE_REVOKE_URL, createGoogleTokenRevoker } from './google-disconnect';
import type { FetchLike } from './google-oauth';

/**
 * Google's revoke endpoint, as its docs describe it (developers.google.com/identity/
 * protocols/oauth2/web-server, "Token revocation"): POST the token form-encoded to
 * oauth2.googleapis.com/revoke; 200 is success, an error is 400 with an error code.
 * The fake is only the transport; every expectation below is read from that page.
 */

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

function answering(status: number, body: unknown = {}): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, ...init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, seen };
}

describe('createGoogleTokenRevoker', () => {
  it('POSTs the token form-encoded to Google’s revoke endpoint', async () => {
    const { fetch, seen } = answering(200);

    await createGoogleTokenRevoker(fetch).revoke('1//r');

    expect(GOOGLE_REVOKE_URL).toBe('https://oauth2.googleapis.com/revoke');
    expect(seen).toEqual([
      {
        url: 'https://oauth2.googleapis.com/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=1%2F%2Fr',
      },
    ]);
  });

  it.each([
    [200, {}, { outcome: 'revoked' }],
    [400, { error: 'invalid_token' }, { outcome: 'invalid_token' }],
    [400, { error: 'invalid_request' }, { outcome: 'refused', status: 400 }],
    [401, {}, { outcome: 'refused', status: 401 }],
    [503, {}, { outcome: 'unavailable', status: 503 }],
    [429, {}, { outcome: 'unavailable', status: 429 }],
  ])('maps %i %j to %j', async (status, body, expected) => {
    const { fetch } = answering(status, body);
    expect(await createGoogleTokenRevoker(fetch).revoke('1//r')).toEqual(expected);
  });

  it('a network failure is transient, with no status', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await createGoogleTokenRevoker(fetch).revoke('1//r')).toEqual({
      outcome: 'unavailable',
      status: null,
    });
  });

  it('a 400 whose body is not JSON is refused, not mistaken for an expired token', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    expect(await createGoogleTokenRevoker(fetch).revoke('1//r')).toEqual({
      outcome: 'refused',
      status: 400,
    });
  });
});

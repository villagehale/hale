import { describe, expect, it, vi } from 'vitest';
import { BrowserUseApiError, browserUseApi, browserUseApiFromEnv } from './client';
import { browserUseSignupEnabled } from './flag';
import {
  BROWSER_USE_SIGNUP_OUTPUT_SCHEMA,
  parseSignupOutput,
  sameProviderHttpsUrl,
} from './outcome';
import { browserUseSignupRunnerFromEnv, remoteProfileDeleterFromEnv } from './runner';
import { type CdpConnector, cdpSessionSeeder } from './seed';
import { parseProviderStorageState } from './vault';

describe('browser use signup flag', () => {
  it('is on only for exactly `true`', () => {
    expect(browserUseSignupEnabled({})).toBe(false);
    for (const value of ['', 'on', '1', 'TRUE', 'true\n', ' true']) {
      expect(browserUseSignupEnabled({ BROWSER_USE_SIGNUP_ENABLED: value }), value).toBe(false);
    }
    expect(browserUseSignupEnabled({ BROWSER_USE_SIGNUP_ENABLED: 'true' })).toBe(true);
  });
});

describe('browser use client', () => {
  it('names a missing key instead of building a client', () => {
    expect(browserUseApiFromEnv({})).toEqual({
      api: null,
      skipped: 'not_configured',
      missing: ['BROWSER_USE_API_KEY'],
    });
    expect(browserUseApiFromEnv({ BROWSER_USE_API_KEY: '   ' }).skipped).toBe('not_configured');
    expect(browserUseSignupRunnerFromEnv({}).skipped).toBe('not_configured');
    expect(remoteProfileDeleterFromEnv({})).toEqual({ kind: 'not_configured' });
  });

  it('builds without calling the network', () => {
    const fetchImpl = vi.fn();
    const built = browserUseSignupRunnerFromEnv({ BROWSER_USE_API_KEY: 'k' }, fetchImpl);
    expect(built.runner).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls the US v4 base with the key header and throws on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ detail: 'nope' }, { status: 401 }));
    const api = browserUseApi({ apiKey: 'k', fetch: fetchImpl });
    await expect(api.getRunStatus('r1')).rejects.toBeInstanceOf(BrowserUseApiError);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.browser-use.com/api/v4/runs/r1/status');
    expect(new Headers(init.headers).get('X-Browser-Use-API-Key')).toBe('k');
  });

  it('deletes a profile and accepts an empty 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await browserUseApi({ apiKey: 'k', fetch: fetchImpl }).deleteProfile('p/1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.browser-use.com/api/v4/profiles/p%2F1');
    expect(init.method).toBe('DELETE');
  });
});

describe('browser use outcome', () => {
  it('requires every field in the schema', () => {
    expect(BROWSER_USE_SIGNUP_OUTPUT_SCHEMA.required).toHaveLength(6);
    expect(parseSignupOutput({ outcome: 'reached_checkout' })).toBeNull();
    expect(
      parseSignupOutput({
        outcome: 'waitlist',
        detail: 'none',
        checkout_url: null,
        cart_total_cents: null,
        hold_minutes: null,
        payment_details_entered: false,
      })?.outcome,
    ).toBe('waitlist');
  });

  it('keeps a checkout url only on the provider site over https', () => {
    const home = 'https://cityofvaughan.perfectmind.com/23970/Clients/BookMe4';
    expect(sameProviderHttpsUrl('https://cityofvaughan.perfectmind.com/Checkout', home)).toBe(
      'https://cityofvaughan.perfectmind.com/Checkout',
    );
    expect(sameProviderHttpsUrl('http://cityofvaughan.perfectmind.com/Checkout', home)).toBeNull();
    expect(sameProviderHttpsUrl('https://evil.test/perfectmind.com', home)).toBeNull();
    expect(sameProviderHttpsUrl('not a url', home)).toBeNull();
    expect(sameProviderHttpsUrl(null, home)).toBeNull();
  });
});

describe('provider storage state', () => {
  const cookie = { name: 'sid', value: 'v', domain: '.example.test' };

  it('accepts a Playwright storage state', () => {
    const state = parseProviderStorageState({ cookies: [cookie], origins: [] });
    expect(state?.cookies[0]).toMatchObject({ name: 'sid', path: '/', secure: true });
  });

  it('refuses anything named like a password, and empty states', () => {
    expect(parseProviderStorageState({ cookies: [{ ...cookie, name: 'password' }] })).toBeNull();
    expect(
      parseProviderStorageState({
        cookies: [cookie],
        origins: [
          { origin: 'https://example.test', localStorage: [{ name: 'savedPwd', value: 'x' }] },
        ],
      }),
    ).toBeNull();
    expect(parseProviderStorageState({ cookies: [], origins: [] })).toBeNull();
    expect(parseProviderStorageState('cookies')).toBeNull();
  });
});

describe('cdp session seeder', () => {
  it('adds cookies, writes local storage per origin and disconnects', async () => {
    const calls: string[] = [];
    const connector: CdpConnector = {
      async connectOverCDP(endpoint) {
        calls.push(`connect ${endpoint}`);
        return {
          contexts: () => [
            {
              async addCookies(cookies) {
                calls.push(`cookies ${cookies.length}`);
              },
              async newPage() {
                return {
                  async goto(url: string) {
                    calls.push(`goto ${url}`);
                  },
                  async evaluate(_fn: unknown, arg: unknown) {
                    calls.push(`storage ${JSON.stringify(arg)}`);
                  },
                  async close() {
                    calls.push('page closed');
                  },
                };
              },
            },
          ],
          async close() {
            calls.push('disconnected');
          },
        };
      },
    };
    const state = parseProviderStorageState({
      cookies: [{ name: 'sid', value: 'v', domain: '.example.test' }],
      origins: [{ origin: 'https://example.test', localStorage: [{ name: 'k', value: 'v' }] }],
    });
    if (!state) throw new Error('fixture state invalid');
    await cdpSessionSeeder(connector).seed('wss://cdp.example.test', state);
    expect(calls).toEqual([
      'connect wss://cdp.example.test',
      'cookies 1',
      'goto https://example.test',
      'storage [{"name":"k","value":"v"}]',
      'page closed',
      'disconnected',
    ]);
  });
});

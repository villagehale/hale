import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGoogleAuthUrl,
  CONNECTOR_SCOPES,
  type ConnectorProvider,
  connectorClientSource,
  connectorRedirectUri,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './google-oauth';

const REDIRECT = 'https://app.villagehale.com/api/integrations/google/callback';

describe('buildGoogleAuthUrl', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-123.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-abc';
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('requests offline access + forced consent so a refresh token is issued', () => {
    const url = new URL(buildGoogleAuthUrl({ provider: 'gcal', state: 's1', redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    // NO include_granted_scopes (rule #1): each connector's grant is scoped to
    // ITSELF, so a gcal token never carries gmail.readonly and disconnecting a
    // connector actually kills Hale's capability for that provider.
    expect(p.get('include_granted_scopes')).toBeNull();
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('client-123.apps.googleusercontent.com');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('state')).toBe('s1');
  });

  it('scopes the consent to exactly the connector being connected (read-only)', () => {
    const scopeOf = (provider: ConnectorProvider) =>
      new URL(buildGoogleAuthUrl({ provider, state: 'x', redirectUri: REDIRECT })).searchParams.get(
        'scope',
      );
    expect(scopeOf('gcal')).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(scopeOf('gmail')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopeOf('gdrive')).toBe('https://www.googleapis.com/auth/drive.readonly');
    // Every connector scope is read-only — connectors never mutate the user's Google data.
    for (const scopes of Object.values(CONNECTOR_SCOPES)) {
      for (const s of scopes) expect(s).toMatch(/\.readonly$/);
    }
  });

  it('throws when the Google client is not configured', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = '';
    expect(() => buildGoogleAuthUrl({ provider: 'gcal', state: 's', redirectUri: REDIRECT })).toThrow(
      /GOOGLE_OAUTH_CLIENT_ID/,
    );
  });
});

describe('exchangeCodeForTokens', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-123.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-abc';
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('maps Google token response → OAuthTokens (offline access preserved)', async () => {
    let sentBody = '';
    const fakeFetch = async (_url: string, init: { body?: string }) => {
      sentBody = init.body ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.readonly',
          token_type: 'Bearer',
        }),
      };
    };
    const before = Date.now();
    const tokens = await exchangeCodeForTokens(
      { code: 'auth-code', redirectUri: REDIRECT },
      fakeFetch,
    );
    expect(tokens.accessToken).toBe('ya29.access');
    expect(tokens.refreshToken).toBe('1//refresh');
    expect(tokens.scope).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(tokens.tokenType).toBe('Bearer');
    // expiresAt is ~now + expires_in*1000.
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
    // The exchange is an authorization_code grant carrying the real code + client creds.
    expect(sentBody).toContain('grant_type=authorization_code');
    expect(sentBody).toContain('code=auth-code');
  });

  it('throws on a non-ok token response (never returns partial tokens)', async () => {
    const fakeFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    await expect(
      exchangeCodeForTokens({ code: 'bad', redirectUri: REDIRECT }, fakeFetch),
    ).rejects.toThrow(/400/);
  });
});

describe('refreshAccessToken', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-123.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-abc';
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('POSTs a refresh_token grant and maps the new access token', async () => {
    let sentBody = '';
    const fakeFetch = async (_url: string, init: { body?: string }) => {
      sentBody = init.body ?? '';
      // Google omits refresh_token on a refresh — only a new access token comes back.
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.refreshed', expires_in: 3600, token_type: 'Bearer' }),
      };
    };
    const before = Date.now();
    const tokens = await refreshAccessToken('1//stored-refresh', fakeFetch);
    expect(tokens.accessToken).toBe('ya29.refreshed');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(sentBody).toContain('grant_type=refresh_token');
    expect(sentBody).toContain('refresh_token=1%2F%2Fstored-refresh');
  });

  it('throws on a non-ok refresh response (never returns partial tokens)', async () => {
    const fakeFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    await expect(refreshAccessToken('1//revoked', fakeFetch)).rejects.toThrow(/400/);
  });
});

/**
 * WHICH Google Cloud PROJECT the connector grant belongs to.
 *
 * Verification state, the brand review and the 100-new-user unverified cap all attach
 * to a project's OAuth consent screen, so "the connector has its own client" is only
 * true if that client lives in its own project. The code cannot check that from here —
 * a project id is not in the env — so what it CAN do is refuse to be silent about which
 * pair it used (rule #11), and never break when the connector pair is absent.
 */
describe('connectorClientSource', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'signin-id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'signin-secret';
    process.env.GOOGLE_CONNECTOR_CLIENT_ID = '';
    process.env.GOOGLE_CONNECTOR_CLIENT_SECRET = '';
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('names the sign-in project when the connector pair is unset - and still mints a consent', () => {
    expect(connectorClientSource()).toBe('signin_project');
    expect(
      new URL(buildGoogleAuthUrl({ provider: 'gcal', state: 's', redirectUri: REDIRECT })).searchParams.get(
        'client_id',
      ),
    ).toBe('signin-id.apps.googleusercontent.com');
  });

  it('prefers the connector project when both of its vars are set', () => {
    process.env.GOOGLE_CONNECTOR_CLIENT_ID = 'connector-id.apps.googleusercontent.com';
    process.env.GOOGLE_CONNECTOR_CLIENT_SECRET = 'connector-secret';

    expect(connectorClientSource()).toBe('connector_project');
    expect(
      new URL(buildGoogleAuthUrl({ provider: 'gcal', state: 's', redirectUri: REDIRECT })).searchParams.get(
        'client_id',
      ),
    ).toBe('connector-id.apps.googleusercontent.com');
  });

  /** An id from one project with a secret from another is a token exchange that fails
   * at Google and nothing in our data saying why. Half-set is the sign-in pair, whole. */
  it.each([
    ['id only', 'connector-id.apps.googleusercontent.com', ''],
    ['secret only', '', 'connector-secret'],
  ])('treats a half-set connector pair (%s) as the sign-in project, never a mix', (_n, id, secret) => {
    process.env.GOOGLE_CONNECTOR_CLIENT_ID = id;
    process.env.GOOGLE_CONNECTOR_CLIENT_SECRET = secret;

    expect(connectorClientSource()).toBe('signin_project');
    expect(
      new URL(buildGoogleAuthUrl({ provider: 'gcal', state: 's', redirectUri: REDIRECT })).searchParams.get(
        'client_id',
      ),
    ).toBe('signin-id.apps.googleusercontent.com');
  });

  it('exchanges the code with the SAME project that granted the consent', async () => {
    process.env.GOOGLE_CONNECTOR_CLIENT_ID = 'connector-id.apps.googleusercontent.com';
    process.env.GOOGLE_CONNECTOR_CLIENT_SECRET = 'connector-secret';
    let sentBody = '';
    const fetchImpl = async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.x' }) };
    };

    await exchangeCodeForTokens({ code: 'c', redirectUri: REDIRECT }, fetchImpl);

    const sent = new URLSearchParams(sentBody);
    expect(sent.get('client_id')).toBe('connector-id.apps.googleusercontent.com');
    expect(sent.get('client_secret')).toBe('connector-secret');
  });
});

describe('connectorRedirectUri', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is built from APP_URL - one string, registered with Google once', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    expect(connectorRedirectUri()).toBe('https://app.example.com/api/integrations/callback');
  });

  it('falls back to the production app host, never the marketing one', () => {
    vi.stubEnv('NEXT_PUBLIC_MARKETING_URL', 'https://villagehale.com');
    vi.stubEnv('APP_URL', undefined);
    expect(connectorRedirectUri()).toBe('https://app.villagehale.com/api/integrations/callback');
  });
});

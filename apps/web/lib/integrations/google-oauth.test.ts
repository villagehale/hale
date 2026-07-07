import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGoogleAuthUrl,
  CONNECTOR_SCOPES,
  type ConnectorProvider,
  exchangeCodeForTokens,
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
    // Incremental authorization — keep scopes already granted at sign-in.
    expect(p.get('include_granted_scopes')).toBe('true');
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

import { describe, expect, it } from 'vitest';
import { CONNECTOR_SCOPES, buildGoogleAuthUrl, requestedConnectorScopes } from './google-oauth';
import {
  CALENDAR_EVENTS_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV,
  GOOGLE_WRITE_SCOPES_ENABLED_ENV,
  googleWriteScopesEnabled,
  googleWriteScopesEnabledFor,
  grantedWriteScopesAllowed,
} from './google-write-flag';

const REDIRECT = 'https://app.villagehale.com/api/integrations/callback';

function scopeParam(
  provider: 'gcal' | 'gmail' | 'gdrive',
  env: Record<string, string | undefined>,
): string | null {
  const previous = process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
  if (env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] === undefined) {
    delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
  } else {
    process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] = env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
  }
  process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'client-123.apps.googleusercontent.com';
  try {
    return new URL(
      buildGoogleAuthUrl({ provider, state: 's', redirectUri: REDIRECT }),
    ).searchParams.get('scope');
  } finally {
    if (previous === undefined) delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
    else process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] = previous;
  }
}

describe('GOOGLE_WRITE_SCOPES_ENABLED', () => {
  it('is on only for the exact string true', () => {
    expect(googleWriteScopesEnabled({})).toBe(false);
    expect(googleWriteScopesEnabled({ GOOGLE_WRITE_SCOPES_ENABLED: 'true' })).toBe(true);
    expect(googleWriteScopesEnabled({ GOOGLE_WRITE_SCOPES_ENABLED: 'TRUE' })).toBe(false);
    expect(googleWriteScopesEnabled({ GOOGLE_WRITE_SCOPES_ENABLED: 'true\n' })).toBe(false);
    expect(googleWriteScopesEnabled({ GOOGLE_WRITE_SCOPES_ENABLED: '1' })).toBe(false);
  });

  it('leaves the requested scopes byte-for-byte unchanged when the flag is off', () => {
    const off = {};
    expect(scopeParam('gcal', off)).toBe(
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.profile',
    );
    expect(scopeParam('gmail', off)).toBe(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.profile',
    );
    expect(scopeParam('gdrive', off)).toBe(
      'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile',
    );
    expect(grantedWriteScopesAllowed(off)).toEqual([]);
    for (const scopes of Object.values(CONNECTOR_SCOPES)) {
      for (const scope of scopes) expect(scope).toMatch(/\.readonly$/);
    }
  });

  it('adds calendar.events and gmail.compose when the flag is on, and does not touch Drive or gmail.send', () => {
    const on = { GOOGLE_WRITE_SCOPES_ENABLED: 'true' };
    const gcal = scopeParam('gcal', on);
    const gmail = scopeParam('gmail', on);
    const gdrive = scopeParam('gdrive', on);
    expect(gcal).toBe(
      `${CONNECTOR_SCOPES.gcal[0]} ${CALENDAR_EVENTS_SCOPE} https://www.googleapis.com/auth/userinfo.profile`,
    );
    expect(gmail).toBe(
      `${CONNECTOR_SCOPES.gmail[0]} ${GMAIL_COMPOSE_SCOPE} https://www.googleapis.com/auth/userinfo.profile`,
    );
    expect(gdrive).toBe(
      'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile',
    );
    expect(gcal).not.toContain('gmail.send');
    expect(gmail).not.toContain('gmail.send');
    expect(gdrive).not.toContain('gmail.send');
    expect(grantedWriteScopesAllowed(on)).toEqual([CALENDAR_EVENTS_SCOPE, GMAIL_COMPOSE_SCOPE]);
    process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] = 'true';
    process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'client-123.apps.googleusercontent.com';
    const url = new URL(
      buildGoogleAuthUrl({ provider: 'gmail', state: 's', redirectUri: REDIRECT }),
    );
    // The flag adds scopes to this connector's own grant. It does not union
    // grants across connectors.
    expect(url.searchParams.get('include_granted_scopes')).toBeNull();
    expect(url.searchParams.get('scope')).not.toContain('gmail.send');
    delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
  });

  it('leaves a non-allowlisted user on the readonly scopes when the flag is unset', () => {
    const env = { [GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV]: 'user-allow' };
    expect(requestedConnectorScopes('gcal', env, 'user-other')).toBe(CONNECTOR_SCOPES.gcal);
    expect(requestedConnectorScopes('gmail', env, 'user-other')).toBe(CONNECTOR_SCOPES.gmail);
    expect(requestedConnectorScopes('gdrive', env, 'user-allow')).toBe(CONNECTOR_SCOPES.gdrive);
    expect(grantedWriteScopesAllowed(env, 'user-other')).toEqual([]);
    expect(googleWriteScopesEnabledFor(null, env)).toBe(false);
    expect(googleWriteScopesEnabledFor(undefined, env)).toBe(false);
  });

  it('adds calendar.events and gmail.compose for an allowlisted user while the flag is unset', () => {
    const env = { [GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV]: ' user-allow , ,user-two ' };
    expect(requestedConnectorScopes('gcal', env, 'user-allow')).toEqual([
      ...CONNECTOR_SCOPES.gcal,
      CALENDAR_EVENTS_SCOPE,
    ]);
    expect(requestedConnectorScopes('gmail', env, 'user-two')).toEqual([
      ...CONNECTOR_SCOPES.gmail,
      GMAIL_COMPOSE_SCOPE,
    ]);
    expect(requestedConnectorScopes('gcal', env, 'user-allow').join(' ')).not.toContain(
      'gmail.send',
    );
    expect(requestedConnectorScopes('gmail', env, 'user-two').join(' ')).not.toContain(
      'gmail.send',
    );
    expect(grantedWriteScopesAllowed(env, 'user-allow')).toEqual([
      CALENDAR_EVENTS_SCOPE,
      GMAIL_COMPOSE_SCOPE,
    ]);
    const previous = process.env[GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV];
    process.env[GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV] = 'user-allow';
    delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
    process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'client-123.apps.googleusercontent.com';
    try {
      const url = new URL(
        buildGoogleAuthUrl({
          provider: 'gcal',
          state: 's',
          redirectUri: REDIRECT,
          userId: 'user-allow',
        }),
      );
      expect(url.searchParams.get('scope')).toContain(CALENDAR_EVENTS_SCOPE);
      expect(url.searchParams.get('scope')).not.toContain('gmail.send');
      expect(url.searchParams.get('include_granted_scopes')).toBeNull();
      const other = new URL(
        buildGoogleAuthUrl({
          provider: 'gcal',
          state: 's',
          redirectUri: REDIRECT,
          userId: 'user-other',
        }),
      );
      expect(other.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.profile',
      );
    } finally {
      if (previous === undefined) delete process.env[GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV];
      else process.env[GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV] = previous;
    }
  });
});

import { describe, expect, it } from 'vitest';
import { CONNECTOR_SCOPES, buildGoogleAuthUrl } from './google-oauth';
import {
  CALENDAR_EVENTS_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GOOGLE_WRITE_SCOPES_ENABLED_ENV,
  googleWriteScopesEnabled,
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
});

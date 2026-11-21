import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_SCOPES,
  GOOGLE_BUNDLE_CONNECTORS,
  GOOGLE_PROFILE_SCOPE,
  buildGoogleBundleAuthUrl,
  requestedBundleScopes,
  splitBundleGrant,
} from './google-oauth';
import { CALENDAR_EVENTS_SCOPE, GMAIL_COMPOSE_SCOPE } from './google-write-flag';

/**
 * VIL-721 · the one texted link asks Google for Gmail and the calendar in ONE consent.
 * The bundle asks for exactly what each connector asks for alone, never sets
 * include_granted_scopes, and a grant is split back into the connectors whose scopes
 * all arrived; anything the consent did not ask for is `unexpected`.
 */

const GMAIL = CONNECTOR_SCOPES.gmail[0] as string;
const GCAL = CONNECTOR_SCOPES.gcal[0] as string;
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const ARMED = { GOOGLE_WRITE_SCOPES_ENABLED: 'true' };
const UNARMED = {};

beforeEach(() => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-test.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', '');
  vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', '');
  vi.stubEnv('GOOGLE_WRITE_SCOPES_ALLOWLIST', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requestedBundleScopes', () => {
  it('asks for the two read-only scopes and nothing else for an unarmed user', () => {
    expect(GOOGLE_BUNDLE_CONNECTORS).toEqual(['gmail', 'gcal']);
    expect(requestedBundleScopes(UNARMED, 'user-1')).toEqual([GMAIL, GCAL]);
  });

  it('adds each connector its own write scope only for an armed user', () => {
    expect(requestedBundleScopes(ARMED, 'user-1')).toEqual([
      GMAIL,
      GMAIL_COMPOSE_SCOPE,
      GCAL,
      CALENDAR_EVENTS_SCOPE,
    ]);
  });
});

describe('buildGoogleBundleAuthUrl', () => {
  it('asks for both read scopes plus the profile, offline, with a forced consent', () => {
    const url = new URL(
      buildGoogleBundleAuthUrl({
        state: 'signed.state',
        redirectUri: 'https://app.example.com/api/integrations/callback',
        userId: 'user-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([GMAIL, GCAL, GOOGLE_PROFILE_SCOPE]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed.state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/integrations/callback',
    );
    expect(url.searchParams.get('client_id')).toBe('client-test.apps.googleusercontent.com');
    // The token carries what THIS consent asked for, never earlier grants.
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });
});

describe('splitBundleGrant', () => {
  it('grants both connectors when both read scopes arrived', () => {
    expect(splitBundleGrant([GMAIL, GCAL, GOOGLE_PROFILE_SCOPE], UNARMED, 'user-1')).toEqual({
      granted: ['gmail', 'gcal'],
      missing: [],
      unexpected: [],
    });
  });

  it('grants only Gmail when the calendar box was left unticked', () => {
    expect(splitBundleGrant([GMAIL, GOOGLE_PROFILE_SCOPE], UNARMED, 'user-1')).toEqual({
      granted: ['gmail'],
      missing: [GCAL],
      unexpected: [],
    });
  });

  it('grants only the calendar when the Gmail box was left unticked', () => {
    expect(splitBundleGrant([GCAL], UNARMED, 'user-1')).toEqual({
      granted: ['gcal'],
      missing: [GMAIL],
      unexpected: [],
    });
  });

  it('grants nothing when only the profile came back', () => {
    expect(splitBundleGrant([GOOGLE_PROFILE_SCOPE], UNARMED, 'user-1')).toEqual({
      granted: [],
      missing: [GMAIL, GCAL],
      unexpected: [],
    });
  });

  it('names a scope the consent never asked for', () => {
    expect(splitBundleGrant([GMAIL, GCAL, DRIVE], UNARMED, 'user-1').unexpected).toEqual([DRIVE]);
  });

  it('names a write scope as unexpected for an unarmed user, and allows it for an armed one', () => {
    expect(splitBundleGrant([GMAIL, GCAL, CALENDAR_EVENTS_SCOPE], UNARMED, 'user-1')).toMatchObject(
      { granted: ['gmail', 'gcal'], unexpected: [CALENDAR_EVENTS_SCOPE] },
    );
    expect(splitBundleGrant([GMAIL, GCAL, CALENDAR_EVENTS_SCOPE], ARMED, 'user-1')).toMatchObject({
      granted: ['gmail', 'gcal'],
      unexpected: [],
    });
  });
});

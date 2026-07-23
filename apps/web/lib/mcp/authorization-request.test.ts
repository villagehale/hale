import { describe, expect, it } from 'vitest';
import { parseMcpAuthorizationRequest } from './authorization-request';

const CLIENT = {
  clientId: 'hale_client_test',
  clientName: 'Example assistant',
  redirectUris: ['https://assistant.example/callback'],
};

const VALID = {
  response_type: 'code',
  client_id: CLIENT.clientId,
  redirect_uri: CLIENT.redirectUris[0],
  resource: 'https://hale.example/api/mcp',
  scope: 'events.read week_plan.read',
  state: 'opaque',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
};

describe('parseMcpAuthorizationRequest', () => {
  it('accepts an exact registered redirect, resource, scopes, and S256 challenge', () => {
    expect(parseMcpAuthorizationRequest(VALID, CLIENT, 'https://hale.example')).toEqual(
      expect.objectContaining({
        clientId: CLIENT.clientId,
        redirectUri: CLIENT.redirectUris[0],
        scopes: ['week_plan.read', 'events.read'],
      }),
    );
  });

  it('refuses an unregistered redirect before any OAuth redirect can occur', () => {
    expect(
      parseMcpAuthorizationRequest(
        { ...VALID, redirect_uri: 'https://evil.example/callback' },
        CLIENT,
        'https://hale.example',
      ),
    ).toBeNull();
  });

  it('refuses unknown scopes, a mismatched resource, and non-S256 PKCE', () => {
    expect(
      parseMcpAuthorizationRequest({ ...VALID, scope: 'admin' }, CLIENT, 'https://hale.example'),
    ).toBeNull();
    expect(
      parseMcpAuthorizationRequest(
        { ...VALID, resource: 'https://hale.example/api/other' },
        CLIENT,
        'https://hale.example',
      ),
    ).toBeNull();
    expect(
      parseMcpAuthorizationRequest(
        { ...VALID, code_challenge_method: 'plain' },
        CLIENT,
        'https://hale.example',
      ),
    ).toBeNull();
  });
});

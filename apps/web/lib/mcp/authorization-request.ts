import { type McpScope, canonicalMcpResource, normalizeRequestedScopes } from './contracts';
import type { RegisteredMcpClient } from './oauth-store';

export interface McpAuthorizationRequest {
  responseType: 'code';
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: McpScope[];
  rawScope: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export type AuthorizationQuery = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One strict parser shared by the consent screen and its POST. In particular, no
 * caller may redirect until the client and exact pre-registered redirect URI have
 * both passed this check.
 */
export function parseMcpAuthorizationRequest(
  query: AuthorizationQuery,
  client: RegisteredMcpClient,
  origin: string,
): McpAuthorizationRequest | null {
  const responseType = scalar(query.response_type);
  const clientId = scalar(query.client_id);
  const redirectUri = scalar(query.redirect_uri);
  const resource = scalar(query.resource);
  const rawScope = scalar(query.scope);
  const state = scalar(query.state);
  const codeChallenge = scalar(query.code_challenge);
  const codeChallengeMethod = scalar(query.code_challenge_method);
  const scopes = rawScope ? normalizeRequestedScopes(rawScope) : null;

  if (
    responseType !== 'code' ||
    clientId !== client.clientId ||
    clientId.length > 256 ||
    !redirectUri ||
    redirectUri.length > 2_048 ||
    !client.redirectUris.includes(redirectUri) ||
    !resource ||
    resource.length > 2_048 ||
    resource !== canonicalMcpResource(origin) ||
    !rawScope ||
    !scopes ||
    rawScope.length > 512 ||
    codeChallengeMethod !== 'S256' ||
    !codeChallenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
    (state !== null && state.length > 1_024)
  ) {
    return null;
  }

  return {
    responseType,
    clientId,
    redirectUri,
    resource,
    scopes,
    rawScope,
    state: state ?? undefined,
    codeChallenge,
    codeChallengeMethod,
  };
}

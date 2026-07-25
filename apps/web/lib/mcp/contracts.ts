import { createHash } from 'node:crypto';

/** The complete, least-privilege scope vocabulary Hale's MCP resource accepts. */
export const MCP_SCOPES = [
  'week_plan.read',
  'events.read',
  'village.read',
  'actions.propose',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * Parse an OAuth space-delimited scope request. Unknown or empty requests fail
 * closed; valid scopes are deduped into the server's stable canonical order.
 */
export function normalizeRequestedScopes(raw: string): McpScope[] | null {
  const requested = new Set(raw.trim().split(/\s+/).filter(Boolean));
  if (requested.size === 0 || [...requested].some((scope) => !isMcpScope(scope))) {
    return null;
  }
  return MCP_SCOPES.filter((scope) => requested.has(scope));
}

/** The OAuth resource indicator for this deployment's one MCP endpoint. */
export function canonicalMcpResource(origin: string): string {
  const url = new URL(origin);
  return new URL('/api/mcp', url.origin).toString();
}

/**
 * OAuth native/public clients may use an HTTPS callback or a loopback HTTP
 * callback. Fragments never reach the authorization server and are refused.
 */
export function validateOAuthRedirectUri(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

/** OAuth PKCE S256 challenge for an authorization-code verifier. */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

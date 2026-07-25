import { createHmac, randomBytes } from 'node:crypto';

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Plaintext is returned once to the OAuth client and is never persisted. */
export function generateMcpAccessToken(): string {
  return randomSecret('hale_mcp_');
}

/** Plaintext is returned once to the authorization redirect and is never persisted. */
export function generateAuthorizationCode(): string {
  return randomSecret('hale_code_');
}

/**
 * Keyed blind index for opaque MCP credentials. A database-only compromise
 * cannot turn a hash into a usable bearer token without AUTH_SECRET as well.
 */
export function mcpSecretHash(secret: string): string {
  const pepper = process.env.AUTH_SECRET;
  if (!pepper) {
    throw new Error('AUTH_SECRET is not set — cannot hash MCP bearer secrets');
  }
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

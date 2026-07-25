import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MCP_SCOPES,
  canonicalMcpResource,
  isMcpScope,
  normalizeRequestedScopes,
  pkceS256,
  validateOAuthRedirectUri,
} from './contracts';

describe('MCP scope contract', () => {
  it('keeps the four product capabilities closed and stable', () => {
    expect(MCP_SCOPES).toEqual([
      'week_plan.read',
      'events.read',
      'village.read',
      'actions.propose',
    ]);
    expect(isMcpScope('events.read')).toBe(true);
    expect(isMcpScope('children.raw')).toBe(false);
  });

  it('dedupes requested scopes in canonical order and rejects unknown scopes', () => {
    expect(
      normalizeRequestedScopes('village.read week_plan.read village.read actions.propose'),
    ).toEqual(['week_plan.read', 'village.read', 'actions.propose']);
    expect(normalizeRequestedScopes('week_plan.read children.raw')).toBeNull();
    expect(normalizeRequestedScopes('')).toBeNull();
  });
});

describe('MCP OAuth boundary helpers', () => {
  it('binds the resource to the canonical /api/mcp endpoint', () => {
    expect(canonicalMcpResource('https://app.villagehale.com/')).toBe(
      'https://app.villagehale.com/api/mcp',
    );
    expect(canonicalMcpResource('https://app.villagehale.com/base')).toBe(
      'https://app.villagehale.com/api/mcp',
    );
  });

  it('allows HTTPS redirects and loopback HTTP only', () => {
    expect(validateOAuthRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(validateOAuthRedirectUri('http://127.0.0.1:43123/callback')).toBe(true);
    expect(validateOAuthRedirectUri('http://localhost:43123/callback')).toBe(true);
    expect(validateOAuthRedirectUri('http://example.com/callback')).toBe(false);
    expect(validateOAuthRedirectUri('https://example.com/callback#fragment')).toBe(false);
    expect(validateOAuthRedirectUri('https://user:password@example.com/callback')).toBe(false);
    expect(validateOAuthRedirectUri('javascript:alert(1)')).toBe(false);
  });

  it('computes the OAuth PKCE S256 challenge exactly', () => {
    const verifier = 'a-secure-code-verifier-with-more-than-forty-three-characters';
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceS256(verifier)).toBe(expected);
  });
});

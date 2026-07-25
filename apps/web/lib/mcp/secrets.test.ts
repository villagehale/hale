import { describe, expect, it, vi } from 'vitest';
import { generateAuthorizationCode, generateMcpAccessToken, mcpSecretHash } from './secrets';

describe('MCP bearer secret handling', () => {
  it('generates an identifiable high-entropy token while storing only a keyed hash', () => {
    vi.stubEnv('AUTH_SECRET', 'test-auth-secret-with-enough-entropy');
    const token = generateMcpAccessToken();

    expect(token).toMatch(/^hale_mcp_[A-Za-z0-9_-]{43}$/);
    expect(mcpSecretHash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(mcpSecretHash(token)).not.toContain(token);
    expect(mcpSecretHash(`${token}x`)).not.toBe(mcpSecretHash(token));
    vi.unstubAllEnvs();
  });

  it('uses a separate opaque shape for short-lived authorization codes', () => {
    const code = generateAuthorizationCode();
    expect(code).toMatch(/^hale_code_[A-Za-z0-9_-]{43}$/);
  });

  it('fails closed when the server secret needed for the blind index is absent', () => {
    vi.stubEnv('AUTH_SECRET', '');
    expect(() => mcpSecretHash('opaque')).toThrow(/AUTH_SECRET/);
    vi.unstubAllEnvs();
  });
});

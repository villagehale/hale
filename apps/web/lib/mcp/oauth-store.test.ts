import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { pkceS256 } from './contracts';
import { exchangeAuthorizationCode } from './oauth-store';
import { mcpSecretHash } from './secrets';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const CODE = 'hale_code_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const VERIFIER = 'a-secure-code-verifier-with-more-than-forty-three-characters';

interface Capture {
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
}

function exchangeDb(
  row: Record<string, unknown>,
  consumeRows: Array<{ id: string }> = [{ id: 'code-id' }],
) {
  const capture: Capture = { updates: [], inserts: [] };
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row]) }),
      }),
    }),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            capture.updates.push({ table, values });
            return consumeRows;
          },
        }),
      }),
    })),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        capture.inserts.push({ table, values });
        return table === schema.mcpGrants
          ? { returning: async () => [{ id: 'grant-id' }] }
          : Promise.resolve();
      },
    })),
  };
  const database = { transaction: (run: (inner: typeof tx) => unknown) => run(tx) };
  return { database: database as never, capture };
}

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'code-id',
    clientId: 'client-id',
    clientName: 'Example assistant',
    userId: 'user-id',
    familyId: 'family-id',
    consentRecordId: 'consent-id',
    redirectUri: 'https://assistant.example/callback',
    resource: 'https://app.example/api/mcp',
    scopes: ['week_plan.read'],
    codeChallenge: pkceS256(VERIFIER),
    expiresAt: new Date('2026-07-22T12:10:00.000Z'),
    ...overrides,
  };
}

describe('exchangeAuthorizationCode', () => {
  it('refuses a wrong PKCE verifier without consuming the code or minting a grant', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-auth-secret-with-enough-entropy');
    const { database, capture } = exchangeDb(codeRow());

    const result = await exchangeAuthorizationCode(
      database,
      {
        code: CODE,
        clientId: 'client-id',
        redirectUri: 'https://assistant.example/callback',
        resource: 'https://app.example/api/mcp',
        codeVerifier: 'wrong-verifier-with-more-than-forty-three-characters',
      },
      NOW,
    );

    expect(result).toEqual({ status: 'invalid_grant' });
    expect(capture.updates).toEqual([]);
    expect(capture.inserts).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('consumes once and stores only the access-token blind index', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-auth-secret-with-enough-entropy');
    const { database, capture } = exchangeDb(codeRow());

    const result = await exchangeAuthorizationCode(
      database,
      {
        code: CODE,
        clientId: 'client-id',
        redirectUri: 'https://assistant.example/callback',
        resource: 'https://app.example/api/mcp',
        codeVerifier: VERIFIER,
      },
      NOW,
    );

    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('expected issued');
    expect(result.accessToken).toMatch(/^hale_mcp_/);
    expect(capture.updates).toHaveLength(1);
    const grant = capture.inserts.find((entry) => entry.table === schema.mcpGrants)?.values;
    expect(grant?.tokenHash).toBe(mcpSecretHash(result.accessToken));
    expect(JSON.stringify(grant)).not.toContain(result.accessToken);
    const audit = capture.inserts.find((entry) => entry.table === schema.auditLog)?.values;
    expect(JSON.stringify(audit)).not.toContain(result.accessToken);
    expect(audit).toMatchObject({
      familyId: 'family-id',
      actor: 'user-id',
      actionTaken: 'mcp.grant_issued',
    });
    vi.unstubAllEnvs();
  });

  it('fails closed when a concurrent exchange already consumed the code', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-auth-secret-with-enough-entropy');
    const { database, capture } = exchangeDb(codeRow(), []);

    const result = await exchangeAuthorizationCode(
      database,
      {
        code: CODE,
        clientId: 'client-id',
        redirectUri: 'https://assistant.example/callback',
        resource: 'https://app.example/api/mcp',
        codeVerifier: VERIFIER,
      },
      NOW,
    );

    expect(result).toEqual({ status: 'invalid_grant' });
    expect(capture.inserts).toEqual([]);
    vi.unstubAllEnvs();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two mobile connector routes — GET /api/mobile/integrations (the family's
 * connector state) and POST /api/mobile/integrations/[provider]/disconnect — over
 * the REAL store fns + a fake tx db that records the WHERE bindings, so the
 * family-scoping (rule #1) and the disconnect's revoke+audit (rule #6) are actually
 * exercised, not stipulated. @hale/db's createDb is poisoned so a route that builds
 * its own db fails loudly (rule #1). Load-bearing: the list must NEVER serialize a
 * token or scope, and disconnect must revoke ONLY the caller's own (family,user)
 * connection.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const CONNECTED_AT = new Date('2026-07-01T00:00:00.000Z');

interface IntegrationRow {
  familyId: string;
  userId: string | null;
  provider: string;
  status: string;
  scopes: string[];
  oauthTokensEncrypted: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
}

interface Capture {
  updateWheres: Record<string, unknown>[];
  updateSets: Record<string, unknown>[];
  auditRows: Record<string, unknown>[];
}

let rows: IntegrationRow[];
let capture: Capture;

// Walk a Drizzle SQL's queryChunks, collecting the column=value equality bindings
// (mirrors the docs-route fake db) so the real WHERE is EVALUATED, not stubbed.
function eqConstraints(
  sql: { queryChunks?: unknown[] },
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  const chunks = sql?.queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    const c = chunk as {
      constructor?: { name?: string };
      name?: string;
      table?: unknown;
      value?: unknown;
    };
    if (c?.constructor?.name === 'SQL') {
      eqConstraints(chunk as { queryChunks?: unknown[] }, out);
      lastCol = null;
      continue;
    }
    if (typeof c?.name === 'string' && c.table) {
      lastCol = c.name;
      continue;
    }
    if (c?.constructor?.name === 'Param' && lastCol) {
      out[lastCol] = c.value;
      lastCol = null;
    }
  }
  return out;
}

function matching(where: { queryChunks?: unknown[] }): IntegrationRow[] {
  const c = eqConstraints(where);
  return rows.filter(
    (r) =>
      (c.family_id === undefined || r.familyId === c.family_id) &&
      (c.user_id === undefined || r.userId === c.user_id) &&
      (c.provider === undefined || r.provider === c.provider) &&
      (c.status === undefined || r.status === c.status),
  );
}

function selectBuilder() {
  return {
    from() {
      return {
        where(where: { queryChunks?: unknown[] }) {
          return Promise.resolve(
            matching(where).map((r) => ({
              provider: r.provider,
              status: r.status,
              scopes: r.scopes,
              lastSyncAt: r.lastSyncAt,
              connectedAt: r.createdAt,
            })),
          );
        },
      };
    },
  };
}

function txHandle() {
  return {
    update() {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(where: { queryChunks?: unknown[] }) {
              const hit = matching(where);
              return {
                returning() {
                  if (hit.length > 0) {
                    capture.updateWheres.push(eqConstraints(where));
                    capture.updateSets.push(patch);
                    for (const r of hit) r.status = 'revoked';
                  }
                  return Promise.resolve(hit.map(() => ({ id: 'revoked-id' })));
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(row: Record<string, unknown>) {
          capture.auditRows.push(row);
          return Promise.resolve();
        },
      };
    },
  };
}

function fakeDb() {
  return {
    select: () => selectBuilder(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle()),
  };
}

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile integrations route must NOT construct its own db (rule #1)');
    },
  };
});

function row(over: Partial<IntegrationRow>): IntegrationRow {
  return {
    familyId: FAMILY_ID,
    userId: USER_ID,
    provider: 'gcal',
    status: 'active',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    oauthTokensEncrypted: 'ENCRYPTED_TOKEN_BLOB',
    lastSyncAt: null,
    createdAt: CONNECTED_AT,
    ...over,
  };
}

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/integrations/route');
  return GET();
}

async function callDisconnect(provider: string): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/integrations/[provider]/disconnect/route');
  return POST(
    new Request(`http://localhost/api/mobile/integrations/${provider}/disconnect`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ provider }) },
  );
}

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  resolveFamilyMock.mockReset();
  resolveUserIdMock.mockReset();
  authMock.mockResolvedValue({ user: { id: 'ext-1' } });
  resolveFamilyMock.mockResolvedValue(FAMILY_ID);
  resolveUserIdMock.mockResolvedValue(USER_ID);
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  // The disconnect lib gates on auth being configured (AUTH_SECRET satisfies it),
  // mirroring the notification-prefs degradation — else it returns preview.
  vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
  rows = [];
  capture = { updateWheres: [], updateSets: [], auditRows: [] };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/mobile/integrations', () => {
  it('returns 401 for a signed-out caller and never resolves a family', async () => {
    authMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(resolveFamilyMock).not.toHaveBeenCalled();
  });

  it('returns all three connectors as not_connected when the family has no rows', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: { provider: string; status: string }[] };
    expect(body.connectors.map((c) => `${c.provider}:${c.status}`)).toEqual([
      'gcal:not_connected',
      'gmail:not_connected',
      'gdrive:not_connected',
    ]);
  });

  it("reports an active connection as 'connected' with an ISO connectedAt", async () => {
    rows = [row({ provider: 'gcal', status: 'active' })];
    const res = await callGet();
    const body = (await res.json()) as {
      connectors: { provider: string; status: string; connectedAt?: string }[];
    };
    const gcal = body.connectors.find((c) => c.provider === 'gcal');
    expect(gcal?.status).toBe('connected');
    expect(gcal?.connectedAt).toBe(CONNECTED_AT.toISOString());
  });

  it("a FOREIGN family's active row reads as not_connected in the caller's list (family scoping)", async () => {
    rows = [row({ provider: 'gcal', status: 'active', familyId: FOREIGN_FAMILY_ID })];
    const res = await callGet();
    const body = (await res.json()) as { connectors: { provider: string; status: string }[] };
    expect(body.connectors.find((c) => c.provider === 'gcal')?.status).toBe('not_connected');
  });

  it("the CO-PARENT's active row reads as not_connected in the caller's list (user scoping — so it can't feed a no-op disconnect)", async () => {
    rows = [row({ provider: 'gcal', status: 'active', userId: OTHER_USER_ID })];
    const res = await callGet();
    const body = (await res.json()) as { connectors: { provider: string; status: string }[] };
    expect(body.connectors.find((c) => c.provider === 'gcal')?.status).toBe('not_connected');
  });

  it('NEVER serializes token material or scopes anywhere in the response (rule #1)', async () => {
    rows = [
      row({ provider: 'gcal', status: 'active' }),
      row({ provider: 'gmail', status: 'error' }),
    ];
    const res = await callGet();
    const raw = await res.text();
    expect(raw).not.toContain('ENCRYPTED_TOKEN_BLOB');
    expect(raw).not.toContain('oauth');
    expect(raw).not.toContain('scope');
    expect(raw).not.toContain('googleapis.com');
  });
});

describe('POST /api/mobile/integrations/[provider]/disconnect', () => {
  it('returns 401 for a signed-out caller and never revokes', async () => {
    authMock.mockResolvedValue(null);
    rows = [row({ provider: 'gcal', status: 'active' })];
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(401);
    expect(capture.updateSets).toEqual([]);
    expect(capture.auditRows).toEqual([]);
  });

  it('rejects a non-connector provider with 400 and never touches the db', async () => {
    const res = await callDisconnect('stripe');
    expect(res.status).toBe(400);
    expect(capture.updateSets).toEqual([]);
  });

  it("revokes ONLY the caller's own (family,user,provider) connection + writes ONE audit row (no tokens)", async () => {
    rows = [row({ provider: 'gcal', status: 'active' })];
    const res = await callDisconnect('gcal');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'revoked', provider: 'gcal' });

    // The revoke WHERE is scoped to family AND user AND provider (rule #1).
    expect(capture.updateWheres).toHaveLength(1);
    expect(capture.updateWheres[0]).toMatchObject({
      family_id: FAMILY_ID,
      user_id: USER_ID,
      provider: 'gcal',
    });
    // Tokens are purged (set to null), status revoked.
    expect(capture.updateSets[0]).toMatchObject({ oauthTokensEncrypted: null, status: 'revoked' });

    // One immutable audit row (rule #6), provider only — never a token/email.
    expect(capture.auditRows).toHaveLength(1);
    expect(capture.auditRows[0]).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'integration_revoked',
      after: { provider: 'gcal' },
    });
    expect(JSON.stringify(capture.auditRows[0])).not.toContain('ENCRYPTED_TOKEN_BLOB');
  });

  it("does not revoke another family's connection — 404 not_found, never a false 'revoked'", async () => {
    rows = [row({ provider: 'gcal', status: 'active', familyId: FOREIGN_FAMILY_ID })];
    const res = await callDisconnect('gcal');
    // The revoke matched no row of the caller's — so the endpoint must NOT claim
    // success (that lie makes the mobile chip snap back to Connected, infinitely
    // retryable). It reports not_found, and nothing was touched or audited.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(capture.updateSets).toEqual([]);
    expect(capture.auditRows).toEqual([]);
  });

  it("does not revoke the CO-PARENT's own connection — 404 not_found (revoke is user-scoped)", async () => {
    rows = [row({ provider: 'gcal', status: 'active', userId: OTHER_USER_ID })];
    const res = await callDisconnect('gcal');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(capture.updateSets).toEqual([]);
    expect(capture.auditRows).toEqual([]);
  });
});

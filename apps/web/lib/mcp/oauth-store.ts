import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { MCP_SCOPES, type McpScope, isMcpScope, pkceS256 } from './contracts';
import { generateAuthorizationCode, generateMcpAccessToken, mcpSecretHash } from './secrets';

const AUTH_CODE_TTL_MS = 10 * 60 * 1_000;
export const MCP_GRANT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MCP_GRANT_TTL_MS = MCP_GRANT_TTL_SECONDS * 1_000;

export interface RegisteredMcpClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export async function registerMcpOauthClient(
  database: Database,
  input: { clientName: string; redirectUris: string[] },
): Promise<RegisteredMcpClient> {
  const clientId = `hale_client_${randomBytes(18).toString('base64url')}`;
  await database.insert(schema.mcpOauthClients).values({
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
  });
  return { clientId, clientName: input.clientName, redirectUris: input.redirectUris };
}

export async function readMcpOauthClient(
  database: Database,
  clientId: string,
): Promise<RegisteredMcpClient | null> {
  const rows = await database
    .select({
      clientId: schema.mcpOauthClients.clientId,
      clientName: schema.mcpOauthClients.clientName,
      redirectUris: schema.mcpOauthClients.redirectUris,
    })
    .from(schema.mcpOauthClients)
    .where(eq(schema.mcpOauthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

function consentScope(clientId: string, scopes: readonly McpScope[]): string {
  return JSON.stringify({ clientId, scopes });
}

export async function createMcpAuthorizationCode(
  database: Database,
  input: {
    clientId: string;
    userId: string;
    familyId: string;
    redirectUri: string;
    resource: string;
    scopes: McpScope[];
    codeChallenge: string;
    ip?: string;
    userAgent?: string;
  },
  now: Date = new Date(),
): Promise<string> {
  const code = generateAuthorizationCode();
  const codeHash = mcpSecretHash(code);

  await database.transaction(async (tx) => {
    const consentRows = await tx
      .insert(schema.consentRecords)
      .values({
        userId: input.userId,
        familyId: input.familyId,
        consentType: 'mcp_third_party_model',
        granted: true,
        consentScope: consentScope(input.clientId, input.scopes),
        policyVersion: POLICY_VERSION,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      })
      .returning({ id: schema.consentRecords.id });
    const consentRecordId = consentRows[0]?.id;
    if (!consentRecordId) {
      throw new Error('createMcpAuthorizationCode: consent insert returned no row');
    }

    const codeRows = await tx
      .insert(schema.mcpAuthorizationCodes)
      .values({
        codeHash,
        clientId: input.clientId,
        userId: input.userId,
        familyId: input.familyId,
        consentRecordId,
        redirectUri: input.redirectUri,
        resource: input.resource,
        scopes: input.scopes,
        codeChallenge: input.codeChallenge,
        expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS),
      })
      .returning({ id: schema.mcpAuthorizationCodes.id });
    const codeId = codeRows[0]?.id;
    if (!codeId) {
      throw new Error('createMcpAuthorizationCode: code insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'mcp.authorization_approved',
      targetTable: 'mcp_authorization_codes',
      targetId: codeId,
      after: { clientId: input.clientId, scopes: input.scopes },
    });
  });

  return code;
}

export type ExchangeAuthorizationCodeResult =
  | {
      status: 'issued';
      accessToken: string;
      expiresIn: number;
      scope: string;
    }
  | { status: 'invalid_grant' };

/**
 * OAuth authorization-code exchange. The code lookup is active-only, all bound
 * fields and PKCE are checked before mutation, then a conditional consume and
 * grant mint commit atomically. The raw access token never enters a DB row.
 */
export async function exchangeAuthorizationCode(
  database: Database,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
  },
  now: Date = new Date(),
): Promise<ExchangeAuthorizationCodeResult> {
  const codeHash = mcpSecretHash(input.code);

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.mcpAuthorizationCodes.id,
        clientId: schema.mcpAuthorizationCodes.clientId,
        userId: schema.mcpAuthorizationCodes.userId,
        familyId: schema.mcpAuthorizationCodes.familyId,
        consentRecordId: schema.mcpAuthorizationCodes.consentRecordId,
        redirectUri: schema.mcpAuthorizationCodes.redirectUri,
        resource: schema.mcpAuthorizationCodes.resource,
        scopes: schema.mcpAuthorizationCodes.scopes,
        codeChallenge: schema.mcpAuthorizationCodes.codeChallenge,
      })
      .from(schema.mcpAuthorizationCodes)
      .where(
        and(
          eq(schema.mcpAuthorizationCodes.codeHash, codeHash),
          isNull(schema.mcpAuthorizationCodes.consumedAt),
          gt(schema.mcpAuthorizationCodes.expiresAt, now),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (
      !row ||
      row.clientId !== input.clientId ||
      row.redirectUri !== input.redirectUri ||
      row.resource !== input.resource ||
      row.codeChallenge !== pkceS256(input.codeVerifier) ||
      !Array.isArray(row.scopes) ||
      row.scopes.some((scope) => typeof scope !== 'string' || !isMcpScope(scope))
    ) {
      return { status: 'invalid_grant' };
    }

    const consumed = await tx
      .update(schema.mcpAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.mcpAuthorizationCodes.id, row.id),
          isNull(schema.mcpAuthorizationCodes.consumedAt),
        ),
      )
      .returning({ id: schema.mcpAuthorizationCodes.id });
    if (!consumed[0]) {
      return { status: 'invalid_grant' };
    }

    const scopes = MCP_SCOPES.filter((scope) => row.scopes.includes(scope));
    const accessToken = generateMcpAccessToken();
    const expiresAt = new Date(now.getTime() + MCP_GRANT_TTL_MS);
    const grantRows = await tx
      .insert(schema.mcpGrants)
      .values({
        familyId: row.familyId,
        userId: row.userId,
        clientId: row.clientId,
        consentRecordId: row.consentRecordId,
        tokenHash: mcpSecretHash(accessToken),
        resource: row.resource,
        scopes,
        expiresAt,
      })
      .returning({ id: schema.mcpGrants.id });
    const grantId = grantRows[0]?.id;
    if (!grantId) {
      throw new Error('exchangeAuthorizationCode: grant insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: row.userId,
      actionTaken: 'mcp.grant_issued',
      targetTable: 'mcp_grants',
      targetId: grantId,
      after: { clientId: row.clientId, scopes, expiresAt: expiresAt.toISOString() },
    });

    return {
      status: 'issued',
      accessToken,
      expiresIn: MCP_GRANT_TTL_SECONDS,
      scope: scopes.join(' '),
    };
  });
}

export interface VerifiedMcpGrant {
  grantId: string;
  familyId: string;
  userId: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
}

/** Live DB verification makes revocation and expiry effective on the next call. */
export async function verifyMcpBearer(
  database: Database,
  token: string,
  resource: string,
  now: Date = new Date(),
): Promise<VerifiedMcpGrant | null> {
  const rows = await database
    .select({
      grantId: schema.mcpGrants.id,
      familyId: schema.mcpGrants.familyId,
      userId: schema.mcpGrants.userId,
      clientId: schema.mcpGrants.clientId,
      clientName: schema.mcpOauthClients.clientName,
      scopes: schema.mcpGrants.scopes,
    })
    .from(schema.mcpGrants)
    .innerJoin(
      schema.mcpOauthClients,
      eq(schema.mcpOauthClients.clientId, schema.mcpGrants.clientId),
    )
    .where(
      and(
        eq(schema.mcpGrants.tokenHash, mcpSecretHash(token)),
        eq(schema.mcpGrants.resource, resource),
        isNull(schema.mcpGrants.revokedAt),
        gt(schema.mcpGrants.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    !Array.isArray(row.scopes) ||
    row.scopes.some((scope) => typeof scope !== 'string' || !isMcpScope(scope))
  ) {
    return null;
  }

  await database
    .update(schema.mcpGrants)
    .set({ lastUsedAt: now })
    .where(eq(schema.mcpGrants.id, row.grantId));

  return {
    ...row,
    scopes: MCP_SCOPES.filter((scope) => row.scopes.includes(scope)),
  };
}

export interface McpConnectionSummary {
  id: string;
  clientName: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export async function listMcpConnectionsForUser(
  database: Database,
  familyId: string,
  userId: string,
  now: Date = new Date(),
): Promise<McpConnectionSummary[]> {
  const rows = await database
    .select({
      id: schema.mcpGrants.id,
      clientName: schema.mcpOauthClients.clientName,
      scopes: schema.mcpGrants.scopes,
      createdAt: schema.mcpGrants.createdAt,
      lastUsedAt: schema.mcpGrants.lastUsedAt,
      expiresAt: schema.mcpGrants.expiresAt,
    })
    .from(schema.mcpGrants)
    .innerJoin(
      schema.mcpOauthClients,
      eq(schema.mcpOauthClients.clientId, schema.mcpGrants.clientId),
    )
    .where(
      and(
        eq(schema.mcpGrants.familyId, familyId),
        eq(schema.mcpGrants.userId, userId),
        isNull(schema.mcpGrants.revokedAt),
        gt(schema.mcpGrants.expiresAt, now),
      ),
    );
  return rows.flatMap((row) => {
    if (!Array.isArray(row.scopes) || row.scopes.some((scope) => !isMcpScope(String(scope)))) {
      return [];
    }
    return [
      {
        id: row.id,
        clientName: row.clientName,
        scopes: MCP_SCOPES.filter((scope) => row.scopes.includes(scope)),
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
      },
    ];
  });
}

export type RevokeMcpGrantResult = { status: 'revoked' } | { status: 'not_found' };

export async function revokeMcpGrant(
  database: Database,
  input: {
    grantId: string;
    familyId: string;
    userId: string;
    ip?: string;
    userAgent?: string;
  },
  now: Date = new Date(),
): Promise<RevokeMcpGrantResult> {
  return database.transaction(async (tx) => {
    const revoked = await tx
      .update(schema.mcpGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.mcpGrants.id, input.grantId),
          eq(schema.mcpGrants.familyId, input.familyId),
          eq(schema.mcpGrants.userId, input.userId),
          isNull(schema.mcpGrants.revokedAt),
        ),
      )
      .returning({
        id: schema.mcpGrants.id,
        clientId: schema.mcpGrants.clientId,
        scopes: schema.mcpGrants.scopes,
      });
    const grant = revoked[0];
    if (!grant) return { status: 'not_found' };
    const scopes = MCP_SCOPES.filter((scope) => grant.scopes.includes(scope));

    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'mcp_third_party_model',
      granted: false,
      consentScope: consentScope(grant.clientId, scopes),
      policyVersion: POLICY_VERSION,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'mcp.grant_revoked',
      targetTable: 'mcp_grants',
      targetId: grant.id,
      after: { clientId: grant.clientId, scopes },
    });
    return { status: 'revoked' };
  });
}

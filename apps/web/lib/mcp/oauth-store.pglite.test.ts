import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '~/lib/consent';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { verifyMcpBearer } from './oauth-store';
import { mcpSecretHash } from './secrets';

/**
 * VIL-355 · a bearer grant is a READ INTO A HOUSEHOLD, and until now the only thing
 * standing between it and the children's data was the grant row's own 30-day TTL.
 * `verifyMcpBearer` checked the token, the resource, `revoked_at` and `expires_at` —
 * never whether the person still holds a seat — so every door that removes somebody
 * from a family had to remember this table or the grant outlived the membership.
 *
 * The membership join is the version of that rule nobody has to remember: a seat
 * removed anywhere, for any reason, closes the grant on the very next call. Against
 * the real DDL, because the claim is a join.
 */

const RESOURCE = 'https://app.example/api/mcp';
const TOKEN = 'hale_mcp_ZmFrZS10b2tlbi1mb3ItdGVzdHMtb25seS1ub3QtcmVhbA';
const NOW = new Date('2026-10-01T08:30:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-auth-secret-for-mcp-blind-index';
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users, mcp_oauth_clients cascade');
});

async function seedGrantedFamily(): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:co-parent-1' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'co_parent' });
  await db.database.insert(schema.mcpOauthClients).values({
    clientId: 'client-1',
    clientName: 'Example assistant',
    redirectUris: ['https://assistant.example/callback'],
  });
  const [consent] = await db.database
    .insert(schema.consentRecords)
    .values({
      userId,
      familyId,
      consentType: 'mcp_third_party_model',
      granted: true,
      policyVersion: POLICY_VERSION,
      grantedAt: NOW,
    })
    .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.mcpGrants).values({
    familyId,
    userId,
    clientId: 'client-1',
    consentRecordId: consent?.id as string,
    tokenHash: mcpSecretHash(TOKEN),
    resource: RESOURCE,
    scopes: ['week_plan.read'],
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 3_600_000),
  });
  return { familyId, userId };
}

describe('verifyMcpBearer — a grant is only as live as the seat behind it', () => {
  it('accepts the token while the holder is still seated', async () => {
    const { familyId, userId } = await seedGrantedFamily();

    const verified = await verifyMcpBearer(db.database, TOKEN, RESOURCE, NOW);

    expect(verified).toMatchObject({ familyId, userId, scopes: ['week_plan.read'] });
  });

  it('refuses the same token the moment the seat is gone', async () => {
    const { familyId, userId } = await seedGrantedFamily();
    await db.database
      .delete(schema.familyMembers)
      .where(
        and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
      );

    expect(await verifyMcpBearer(db.database, TOKEN, RESOURCE, NOW)).toBeNull();
  });

  it('refuses a seat held in a DIFFERENT family from the one the grant names', async () => {
    const { familyId, userId } = await seedGrantedFamily();
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other household', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    await db.database
      .delete(schema.familyMembers)
      .where(
        and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
      );
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other?.id as string, userId, role: 'co_parent' });

    expect(await verifyMcpBearer(db.database, TOKEN, RESOURCE, NOW)).toBeNull();
  });
});

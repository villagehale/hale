import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * GET /api/rights/export against real Postgres: real family_members rows, the real seat
 * read and the real audited assembler. Only the session is faked.
 *
 * The unit suite proves the route's branching over a stubbed seat list; this one proves
 * the branching is over the seats the database actually holds — including a person who
 * is a caregiver in one household and a parent in another, which is exactly the case a
 * `limit(1)` membership read gets wrong by heap order.
 */

let t: TestDb;
const authMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => t.database }));

const { GET } = await import('~/app/api/rights/export/route');

type Role = (typeof schema.familyMembers.$inferInsert)['role'];

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'test-auth-secret');
  authMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await t.exec('truncate table families, users, audit_log cascade');
});

/** A signed-in person (their own users row) seated in each of the given households. */
async function seatPerson(externalAuthId: string, seats: Array<{ familyId: string; role: Role }>) {
  const [user] = await t.database
    .insert(schema.users)
    .values({ externalAuthId, name: 'Robin' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  for (const seat of seats) {
    await t.database.insert(schema.familyMembers).values({ ...seat, userId });
  }
  authMock.mockResolvedValue({ user: { id: externalAuthId } });
  return userId;
}

async function exportRows(familyId: string) {
  return t.database
    .select({ actor: schema.auditLog.actor, targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, 'data_exported')),
    );
}

async function callExport() {
  return GET(new Request('http://localhost/api/rights/export'));
}

describe('GET /api/rights/export — whose seat may take the family record', () => {
  it("refuses a nanny the family's record and writes no export row", async () => {
    const family = await seedFamily(t.database, 'Larkspur household');
    await seatPerson('sms:nanny', [{ familyId: family.familyId, role: 'nanny' }]);

    const res = await callExport();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'export_parent_only' });
    expect(await exportRows(family.familyId)).toEqual([]);
  });

  it("gives the primary parent their family's record and writes its audit row", async () => {
    const family = await seedFamily(t.database, 'Larkspur household');
    const parentId = await seatPerson('sms:parent', [
      { familyId: family.familyId, role: 'primary_parent' },
    ]);

    const res = await callExport();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.family.id).toBe(family.familyId);
    expect(body.family.displayName).toBe('Larkspur household');
    expect(await exportRows(family.familyId)).toEqual([
      { actor: parentId, targetId: family.familyId },
    ]);
  });

  it('exports the household a person parents, not the one they help in', async () => {
    const helped = await seedFamily(t.database, 'Juniper household');
    const own = await seedFamily(t.database, 'Larkspur household');
    const personId = await seatPerson('sms:both', [
      { familyId: helped.familyId, role: 'nanny' },
      { familyId: own.familyId, role: 'primary_parent' },
    ]);

    const res = await callExport();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.family.id).toBe(own.familyId);
    expect(body.family.displayName).toBe('Larkspur household');
    expect(await exportRows(own.familyId)).toEqual([{ actor: personId, targetId: own.familyId }]);
    expect(await exportRows(helped.familyId)).toEqual([]);
  });

  it('refuses a parent of two households rather than choosing one', async () => {
    const first = await seedFamily(t.database, 'Juniper household');
    const second = await seedFamily(t.database, 'Larkspur household');
    await seatPerson('sms:two', [
      { familyId: first.familyId, role: 'primary_parent' },
      { familyId: second.familyId, role: 'co_parent' },
    ]);

    const res = await callExport();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'export_family_ambiguous' });
    expect(await exportRows(first.familyId)).toEqual([]);
    expect(await exportRows(second.familyId)).toEqual([]);
  });
});

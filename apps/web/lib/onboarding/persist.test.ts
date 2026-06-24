import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionAndWriteChildren } from './persist.js';

// saveOnboardingChildren reads the Auth.js session + the db at request time. We
// stub those edges so the test exercises the provision-vs-reuse decision (a
// resolved family must NOT spawn a second one), not the real infra.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('~/lib/family', async () => {
  const actual = await vi.importActual<typeof import('~/lib/family')>('~/lib/family');
  return { ...actual, resolveFamilyForUser: vi.fn() };
});

let fakeDbHandle: unknown = {};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

const GOOGLE_ID = 'google_user_abc';
const NEW_USER_ID = '22222222-2222-4222-8222-222222222222';
const NEW_FAMILY_ID = '33333333-3333-4333-8333-333333333333';

const CHILDREN = [
  { name: 'Robin', lastName: 'Stone', dateOfBirth: '2024-01-01', gender: 'girl' as const },
];

/**
 * Chainable query-builder stub: every terminal builder method resolves to the
 * configured rows. .insert records the target table so the test can assert which
 * tables were written (and how many times). The point of these tests is the
 * provisioning shape — a family + a primary_parent membership + an audit row +
 * the children, all in one transaction — not the SQL itself.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'from', 'values', 'onConflictDoNothing', 'returning', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

/**
 * Fake Database whose .transaction(cb) runs cb against a tx stub. The users
 * re-select inside ensureUserRow resolves to `userRows`; the families insert
 * .returning() yields NEW_FAMILY_ID. Records every inserted table.
 */
function stubDb(userRows: Array<{ id: string }>) {
  const insertedTables: string[] = [];

  const tableName = (table: unknown): string => {
    if (table === schema.users) return 'users';
    if (table === schema.families) return 'families';
    if (table === schema.familyMembers) return 'family_members';
    if (table === schema.children) return 'children';
    if (table === schema.auditLog) return 'audit_log';
    return 'other';
  };

  const tx = {
    insert: vi.fn((table: unknown) => {
      insertedTables.push(tableName(table));
      return builder(table === schema.families ? [{ id: NEW_FAMILY_ID }] : [{ id: NEW_USER_ID }]);
    }),
    select: vi.fn(() => builder(userRows)),
  };

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;

  return {
    database,
    inserts: (table: string) => insertedTables.filter((t) => t === table).length,
    insertedTables: () => insertedTables,
    txInsert: () => tx.insert,
  };
}

describe('provisionAndWriteChildren', () => {
  it('creates a family, a primary_parent membership, an audit row, and the children in one transaction', async () => {
    // ensureUserRow finds no existing user first, then resolves the inserted one.
    const s = stubDb([{ id: NEW_USER_ID }]);

    const result = await provisionAndWriteChildren(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' },
      CHILDREN,
    );

    expect(result).toEqual({ familyId: NEW_FAMILY_ID });
    expect(s.inserts('families')).toBe(1);
    expect(s.inserts('family_members')).toBe(1);
    expect(s.inserts('audit_log')).toBe(1);
    expect(s.inserts('children')).toBe(1);

    // The membership links the resolved user to the new family as primary_parent
    // (rule #5: the onboarding creator is the primary parent).
    expect(insertValuesFor(s, 'family_members')).toEqual({
      familyId: NEW_FAMILY_ID,
      userId: NEW_USER_ID,
      role: 'primary_parent',
    });

    // The family creation is audited with the user as actor (rule #6).
    expect(insertValuesFor(s, 'audit_log')).toMatchObject({
      familyId: NEW_FAMILY_ID,
      actor: NEW_USER_ID,
      actionTaken: 'family_created',
      targetTable: 'families',
      targetId: NEW_FAMILY_ID,
    });
  });

  it('derives the family display name from the parent first name', async () => {
    const s = stubDb([{ id: NEW_USER_ID }]);

    await provisionAndWriteChildren(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: 'Avery Stone' },
      CHILDREN,
    );

    const familiesValues = insertValuesFor(s, 'families');
    expect(familiesValues.displayName).toBe("Avery's family");
    // New families start in L1 observe-only (rule #4).
    expect(familiesValues.onboardingStage).toBe('observation_mode');
  });

  it('falls back to a generic display name when the parent has no name', async () => {
    const s = stubDb([{ id: NEW_USER_ID }]);

    await provisionAndWriteChildren(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: null },
      CHILDREN,
    );

    expect(insertValuesFor(s, 'families').displayName).toBe('Your family');
  });
});

describe('saveOnboardingChildren — provision vs reuse', () => {
  const EXISTING_FAMILY_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes children to the existing family without creating a second one', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    const { resolveFamilyForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);

    const insert = vi.fn(() => builder([]));
    fakeDbHandle = { insert, transaction: vi.fn() };

    const { saveOnboardingChildren } = await import('./persist.js');
    const result = await saveOnboardingChildren(CHILDREN, new Date('2026-06-17T00:00:00Z'));

    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.familyId).toBe(EXISTING_FAMILY_ID);
    }
    // Reuse path is a single children insert — never a transaction (no family,
    // membership, or audit row are provisioned for an existing family).
    expect(insert).toHaveBeenCalledTimes(1);
    expect(
      (fakeDbHandle as { transaction: ReturnType<typeof vi.fn> }).transaction,
    ).not.toHaveBeenCalled();
    // The single insert writes the children rows, each carrying the source-of-truth
    // columns: name(s), dateOfBirth, and gender (rule #1 — gender persisted as given).
    const chain = insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    expect(chain.values.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        name: 'Robin',
        lastName: 'Stone',
        dateOfBirth: '2024-01-01',
        gender: 'girl',
      }),
    ]);
  });
});

const SCHEMA_BY_NAME = {
  users: schema.users,
  families: schema.families,
  family_members: schema.familyMembers,
  children: schema.children,
  audit_log: schema.auditLog,
} as const;

/** Extracts the `.values(...)` payload from the insert of the named table. */
function insertValuesFor(
  s: ReturnType<typeof stubDb>,
  table: keyof typeof SCHEMA_BY_NAME,
): Record<string, unknown> {
  const insert = s.txInsert();
  const target = SCHEMA_BY_NAME[table];
  for (let i = 0; i < insert.mock.calls.length; i++) {
    if (insert.mock.calls[i]?.[0] === target) {
      const chain = insert.mock.results[i]?.value as { values: ReturnType<typeof vi.fn> };
      return chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    }
  }
  throw new Error(`no ${table} insert found`);
}

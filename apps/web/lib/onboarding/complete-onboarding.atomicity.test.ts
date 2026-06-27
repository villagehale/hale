import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { completeOnboarding } from './complete-onboarding.js';

// Atomicity of onboarding completion (rule #1, rule #6). Unlike the sibling spec,
// this exercises the REAL provisionAndWriteChildren so the child PII (DOB) insert
// and the consent insert flow through the same transaction machinery. The fake db
// below models Postgres commit/rollback: each transaction() call stages its writes
// and only flushes them to the committed store if its callback resolves; a throw
// discards that transaction's staged writes. Separate transaction() calls commit
// independently — so if child PII and consent are written in SEPARATE transactions,
// a crash after the first commit leaves orphaned child PII with no consent row.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('~/lib/family', async () => {
  const actual = await vi.importActual<typeof import('~/lib/family')>('~/lib/family');
  return { ...actual, resolveFamilyForUser: vi.fn(), ensureUserRow: vi.fn() };
});

let fakeDbHandle: unknown = {};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
  vi.stubEnv('DATABASE_URL', on ? 'postgres://test' : '');
}

const GOOGLE_ID = 'google_user_abc';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const NEW_FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const CHILD = { name: 'Robin', dateOfBirth: '2024-03-15' };

type Write = { table: unknown; values: unknown };

/**
 * A transactional fake. `committed` holds writes from transactions that resolved;
 * each transaction() call stages writes separately and flushes on success or drops
 * them on throw (rollback). `failOn` lets a test inject a throw the first time a
 * given table is inserted, AFTER staging it — modelling a crash mid-write so the
 * surrounding transaction must roll the row back to count as atomic.
 */
function makeTxDb(opts: { failOn?: unknown } = {}) {
  const committed: Write[] = [];
  let tripped = false;

  function executor(staged: Write[]) {
    const builder = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['set', 'where', 'from', 'onConflictDoNothing', 'returning', 'limit']) {
        chain[m] = vi.fn(() => chain);
      }
      // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the mock must be awaitable
      (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
      return chain;
    };
    return {
      select: vi.fn(() => builder([{ id: USER_ID }])),
      update: vi.fn(() => builder([])),
      insert: vi.fn((table: unknown) => {
        const chain = builder(table === schema.families ? [{ id: NEW_FAMILY_ID }] : []);
        (chain as { values: unknown }).values = vi.fn((values: unknown) => {
          staged.push({ table, values });
          if (opts.failOn && table === opts.failOn && !tripped) {
            tripped = true;
            throw new Error('injected crash after write, before commit');
          }
          return chain;
        });
        return chain;
      }),
    };
  }

  const database = {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const staged: Write[] = [];
      const result = await cb(executor(staged));
      committed.push(...staged); // reached only if cb resolved (no rollback)
      return result;
    }),
    // The welcome prior-send lookup + ledger insert live on the top-level db.
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'prev' }] }) }),
    })),
    insert: vi.fn(() => ({ values: async () => undefined })),
  };

  return {
    database,
    committedFor: (table: unknown) => committed.filter((w) => w.table === table),
  };
}

beforeEach(() => {
  authMock.mockReset();
  vi.mocked(resolveFamilyForUser).mockReset();
  vi.mocked(ensureUserRow).mockReset();
  configureAuth(true);
  authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
  vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
  vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completeOnboarding — atomicity (no orphaned child PII)', () => {
  it('rolls back BOTH children and consent when consent recording throws mid-completion', async () => {
    // Inject a crash the first time a consent row is written. If child PII and
    // consent share one transaction, the crash rolls the children back too.
    const s = makeTxDb({ failOn: schema.consentRecords });
    fakeDbHandle = s.database;

    await expect(
      completeOnboarding({ children: [CHILD], planTier: 'plus', tosAccepted: true }),
    ).rejects.toThrow();

    // The invariant: no committed child PII (DOB) without a committed consent row.
    expect(s.committedFor(schema.children)).toHaveLength(0);
    expect(s.committedFor(schema.consentRecords)).toHaveLength(0);
    // The audit rows staged in the same tx (family_created from provisioning +
    // tos_accepted) must roll back too — no orphan audit row (rule #6).
    expect(s.committedFor(schema.auditLog)).toHaveLength(0);
  });

  it('commits children, consent, AND the audit rows together on the happy path', async () => {
    const s = makeTxDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: [CHILD],
      planTier: 'plus',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'completed', familyId: NEW_FAMILY_ID });
    expect(s.committedFor(schema.children)).toHaveLength(1);
    expect(s.committedFor(schema.consentRecords)).toHaveLength(4);
    // Both audit rows commit in the same tx: family_created + tos_accepted (rule #6).
    expect(s.committedFor(schema.auditLog)).toHaveLength(2);
  });
});

import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { provisionAndWriteChildren } from '~/lib/onboarding/persist';
import { completeOnboarding } from './complete-onboarding.js';

// completeOnboarding reads the Auth.js session + the db at request time and reuses
// onboarding's audited provisioning path. We stub those edges so each test
// exercises the action's own decision logic — ToS gating (rule #1), plan capture,
// and the ToS audit row (rule #6) — not real infra. Modules are static so the
// schema table refs the action writes against are the same objects asserted here.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('~/lib/family', async () => {
  const actual = await vi.importActual<typeof import('~/lib/family')>('~/lib/family');
  return { ...actual, resolveFamilyForUser: vi.fn(), ensureUserRow: vi.fn() };
});
vi.mock('~/lib/onboarding/persist', () => ({ provisionAndWriteChildren: vi.fn() }));

let fakeDbHandle: unknown = {};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
  vi.stubEnv('DATABASE_URL', on ? 'postgres://test' : '');
}

const GOOGLE_ID = 'google_user_abc';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const NEW_FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const EXISTING_FAMILY_ID = '44444444-4444-4444-8444-444444444444';

// Phase A captured an approximate age (a month); Phase C collects the full DOB.
const PHASE_C_CHILD = { name: 'Robin', dateOfBirth: '2024-03-15' };

function builder() {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'values']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve([]);
  return chain;
}

/** Fake tx that records each update/insert table + payload. */
function makeDb() {
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];

  const tx = {
    update: vi.fn((table: unknown) => {
      const chain = builder();
      (chain.set as ReturnType<typeof vi.fn>).mockImplementation((values: unknown) => {
        updates.push({ table, values });
        return chain;
      });
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      const chain = builder();
      (chain.values as ReturnType<typeof vi.fn>).mockImplementation((values: unknown) => {
        inserts.push({ table, values });
        return chain;
      });
      return chain;
    }),
  };

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return {
    database,
    updateFor: (table: unknown) => updates.find((u) => u.table === table)?.values,
    insertFor: (table: unknown) => inserts.find((i) => i.table === table)?.values,
  };
}

beforeEach(() => {
  authMock.mockReset();
  vi.mocked(resolveFamilyForUser).mockReset();
  vi.mocked(ensureUserRow).mockReset();
  vi.mocked(provisionAndWriteChildren).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completeOnboarding', () => {
  it('provisions the family, captures the chosen plan, and audits ToS acceptance', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
    vi.mocked(provisionAndWriteChildren).mockResolvedValue({ familyId: NEW_FAMILY_ID });
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      child: PHASE_C_CHILD,
      planTier: 'plus',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'completed', familyId: NEW_FAMILY_ID });

    // Provisioning ran with the Phase-C child (the full DOB carried through).
    expect(provisionAndWriteChildren).toHaveBeenCalledWith(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' },
      [{ name: 'Robin', dateOfBirth: '2024-03-15' }],
    );

    // The chosen plan tier is written to the family (no charge taken).
    expect(s.updateFor(schema.families)).toEqual({ planTier: 'plus' });

    // ToS acceptance is its own audit_log row (rule #6), actor = the parent.
    expect(s.insertFor(schema.auditLog)).toMatchObject({
      familyId: NEW_FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'tos_accepted',
      targetTable: 'families',
      targetId: NEW_FAMILY_ID,
    });
  });

  it('reuses an existing family without provisioning a second one', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      child: PHASE_C_CHILD,
      planTier: 'family',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'completed', familyId: EXISTING_FAMILY_ID });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
    expect(s.updateFor(schema.families)).toEqual({ planTier: 'family' });
  });

  it('rejects when ToS is not accepted — nothing is written', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      child: PHASE_C_CHILD,
      planTier: 'plus',
      tosAccepted: false,
    });

    expect(result).toEqual({ status: 'invalid', error: 'tos_required' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
    expect(s.database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown plan tier', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });

    const result = await completeOnboarding({
      child: PHASE_C_CHILD,
      planTier: 'enterprise',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'invalid', error: 'plan_invalid' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });

  it('previews (no write) when auth is unconfigured', async () => {
    configureAuth(false);

    const result = await completeOnboarding({
      child: PHASE_C_CHILD,
      planTier: 'plus',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'preview' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });
});

import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { provisionAndWriteChildren } from '~/lib/onboarding/persist';
import { completeOnboarding } from './complete-onboarding.js';

// completeOnboarding reads the Auth.js session + the db at request time and reuses
// onboarding's audited provisioning path. We stub those edges so each test
// exercises the action's own decision logic — ToS gating (rule #1), multi-child +
// location persistence, the optional parent-name update, plan capture, and the ToS
// audit row (rule #6) — not real infra. Modules are static so the schema table refs
// the action writes against are the same objects asserted here.
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

// Phase A captured first names only; Phase C collects each full DOB.
const PHASE_C_CHILDREN = [{ name: 'Robin', dateOfBirth: '2024-03-15' }];

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
    updateCount: (table: unknown) => updates.filter((u) => u.table === table).length,
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
      children: PHASE_C_CHILDREN,
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
    expect(s.updateFor(schema.families)).toMatchObject({ planTier: 'plus' });

    // ToS acceptance is its own audit_log row (rule #6), actor = the parent.
    expect(s.insertFor(schema.auditLog)).toMatchObject({
      familyId: NEW_FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'tos_accepted',
      targetTable: 'families',
      targetId: NEW_FAMILY_ID,
    });
  });

  it('provisions ALL children (multi-child) with their full DOBs through the audited path', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
    vi.mocked(provisionAndWriteChildren).mockResolvedValue({ familyId: NEW_FAMILY_ID });
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: [
        { name: 'Robin', dateOfBirth: '2024-03-15' },
        { name: 'Sam', dateOfBirth: '2010-01-01' },
      ],
      planTier: 'family',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'completed', familyId: NEW_FAMILY_ID });
    expect(provisionAndWriteChildren).toHaveBeenCalledWith(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' },
      [
        { name: 'Robin', dateOfBirth: '2024-03-15' },
        { name: 'Sam', dateOfBirth: '2010-01-01' },
      ],
    );
  });

  it('writes the structured location and mirrors postal_code into area_coarse (rule #1)', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'plus',
      tosAccepted: true,
      location: { country: 'Canada', province: 'Ontario', city: 'Toronto', postalCode: ' m5v 2t6 ' },
    });

    expect(result).toEqual({ status: 'completed', familyId: EXISTING_FAMILY_ID });
    // Postal code is normalized (upper-cased, trimmed) and mirrored into areaCoarse.
    // No intents supplied → stored as null (column is nullable).
    expect(s.updateFor(schema.families)).toEqual({
      planTier: 'plus',
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
      areaCoarse: 'M5V 2T6',
      intents: null,
    });
  });

  it('persists the chosen intents (validated + ordered) on the family', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'plus',
      tosAccepted: true,
      // out of canonical order, with a duplicate + an unknown value mixed in
      intents: ['health', 'activities', 'health', 'groceries'],
    });

    expect(result).toEqual({ status: 'completed', familyId: EXISTING_FAMILY_ID });
    // Unknown 'groceries' dropped, duplicate collapsed, canonical order restored.
    expect(s.updateFor(schema.families)).toMatchObject({ intents: ['activities', 'health'] });
  });

  it('stores intents as null when none are chosen (optional, defaults to none)', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'plus',
      tosAccepted: true,
      intents: [],
    });

    expect(s.updateFor(schema.families)).toMatchObject({ intents: null });
  });

  it('updates the parent name when supplied (confirmed Google name) and audits with that actor', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
    vi.mocked(provisionAndWriteChildren).mockResolvedValue({ familyId: NEW_FAMILY_ID });
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'plus',
      tosAccepted: true,
      parentName: '  Avery Q  ',
    });

    expect(result).toEqual({ status: 'completed', familyId: NEW_FAMILY_ID });
    // The edited name flows to provisioning (the family display name) ...
    expect(provisionAndWriteChildren).toHaveBeenCalledWith(
      s.database,
      { externalAuthId: GOOGLE_ID, email: 'avery@example.com', name: 'Avery Q' },
      [{ name: 'Robin', dateOfBirth: '2024-03-15' }],
    );
    // ... and is written (trimmed) to the users row.
    expect(s.updateFor(schema.users)).toEqual({ name: 'Avery Q' });
  });

  it('leaves the users name untouched when no parent name is supplied', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    await completeOnboarding({ children: PHASE_C_CHILDREN, planTier: 'free', tosAccepted: true });

    expect(s.updateCount(schema.users)).toBe(0);
  });

  it('reuses an existing family without provisioning a second one', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
    vi.mocked(resolveFamilyForUser).mockResolvedValue(EXISTING_FAMILY_ID);
    vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'family',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'completed', familyId: EXISTING_FAMILY_ID });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
    expect(s.updateFor(schema.families)).toMatchObject({ planTier: 'family' });
  });

  it('rejects when no children are supplied — nothing is written', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });

    const result = await completeOnboarding({ children: [], planTier: 'plus', tosAccepted: true });

    expect(result).toEqual({ status: 'invalid', error: 'name_required' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });

  it('rejects when any child fails validation (e.g. a future DOB)', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });

    const result = await completeOnboarding({
      children: [
        { name: 'Robin', dateOfBirth: '2024-03-15' },
        { name: 'Sam', dateOfBirth: '2999-01-01' },
      ],
      planTier: 'plus',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'invalid', error: 'dob_future' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });

  it('rejects when ToS is not accepted — nothing is written', async () => {
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });

    const s = makeDb();
    fakeDbHandle = s.database;

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
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
      children: PHASE_C_CHILDREN,
      planTier: 'enterprise',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'invalid', error: 'plan_invalid' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });

  it('previews (no write) when auth is unconfigured', async () => {
    configureAuth(false);

    const result = await completeOnboarding({
      children: PHASE_C_CHILDREN,
      planTier: 'plus',
      tosAccepted: true,
    });

    expect(result).toEqual({ status: 'preview' });
    expect(provisionAndWriteChildren).not.toHaveBeenCalled();
  });
});

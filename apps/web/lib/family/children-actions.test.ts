import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { provisionAndWriteChildren } from '~/lib/onboarding/persist';
import { addChildAction, editChildAction, setAreaAction } from './children-actions.js';

// The Family-page mutations read the Auth.js session + the db at request time, and
// reuse onboarding's audited provisioning path. We stub those edges so each test
// exercises the action's own decision logic — family scoping (rule #1) and the
// audit row (rule #6) — not real infra. Modules are imported statically (no
// resetModules) so the schema table refs the action writes against are the same
// objects this test asserts on; env is read at call-time, so stubEnv alone flips
// the auth/db boundary.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('~/lib/family', async () => {
  const actual = await vi.importActual<typeof import('~/lib/family')>('~/lib/family');
  return { ...actual, resolveFamilyForUser: vi.fn(), ensureUserRow: vi.fn() };
});
vi.mock('~/lib/onboarding/persist', () => ({ provisionAndWriteChildren: vi.fn() }));

let fakeDbHandle: unknown = {};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

const GOOGLE_ID = 'google_user_abc';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_ID = '55555555-5555-4555-8555-555555555555';
const NEW_CHILD_ID = '66666666-6666-4666-8666-666666666666';

/**
 * Chainable query-builder stub. Terminal builder methods resolve to `rows`; the
 * .returning() of the children insert yields a row carrying NEW_CHILD_ID.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'from', 'values', 'returning', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

/**
 * Fake tx whose .insert/.update/.select record their payloads and resolve as the
 * action expects. selectRows seeds the pre-mutation read (existing child / family).
 */
function makeTx(selectRows: unknown[]) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];

  const tx = {
    insert: vi.fn((table: unknown) => {
      const chain = builder(table === schema.children ? [{ id: NEW_CHILD_ID }] : []);
      (chain.values as ReturnType<typeof vi.fn>).mockImplementation((v: unknown) => {
        inserts.push({ table, values: v });
        return chain;
      });
      return chain;
    }),
    update: vi.fn((table: unknown) => {
      const chain = builder([]);
      (chain.set as ReturnType<typeof vi.fn>).mockImplementation((v: unknown) => {
        updates.push({ table, values: v });
        return chain;
      });
      return chain;
    }),
    select: vi.fn(() => builder(selectRows)),
  };

  return { tx, inserts, updates };
}

function valuesFor(rows: Array<{ table: unknown; values: unknown }>, table: unknown) {
  return rows.find((i) => i.table === table)?.values as Record<string, unknown> | undefined;
}

function txDb(tx: ReturnType<typeof makeTx>['tx']) {
  return { transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  configureAuth(true);
  authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'avery@example.com', name: 'Avery' } });
  vi.mocked(resolveFamilyForUser).mockResolvedValue(FAMILY_ID);
  vi.mocked(ensureUserRow).mockResolvedValue(USER_ID);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('addChildAction', () => {
  it('rejects an invalid child without touching the db', async () => {
    fakeDbHandle = {};
    const result = await addChildAction({ name: 'Robin', dateOfBirth: '2999-01-01' });
    expect(result).toEqual({ status: 'invalid', error: 'dob_future' });
  });

  it('writes the child AND a child_added audit row in one transaction for an existing family', async () => {
    const { tx, inserts } = makeTx([]);
    fakeDbHandle = txDb(tx);

    const result = await addChildAction({
      name: 'Robin',
      dateOfBirth: '2024-01-01',
      interests: 'swimming, music',
    });

    expect(result).toEqual({ status: 'added' });
    expect(valuesFor(inserts, schema.children)).toMatchObject({
      familyId: FAMILY_ID,
      name: 'Robin',
      dateOfBirth: '2024-01-01',
      interests: ['swimming', 'music'],
    });
    // Rule #6: the add is audited, actor = the resolved user, target = the new child.
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'child_added',
      targetTable: 'children',
      targetId: NEW_CHILD_ID,
    });
  });

  it('provisions a family (the audited onboarding path) when the parent has none yet', async () => {
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
    vi.mocked(provisionAndWriteChildren).mockResolvedValue({ familyId: FAMILY_ID });
    const transaction = vi.fn();
    fakeDbHandle = { transaction };

    const result = await addChildAction({ name: 'Robin', dateOfBirth: '2024-01-01' });

    expect(result).toEqual({ status: 'added' });
    expect(provisionAndWriteChildren).toHaveBeenCalledTimes(1);
    // No ad-hoc transaction — provisioning owns the family + child + audit rows.
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns preview (no write) when auth is unconfigured', async () => {
    configureAuth(false);
    const transaction = vi.fn();
    fakeDbHandle = { transaction };
    const result = await addChildAction({ name: 'Robin', dateOfBirth: '2024-01-01' });
    expect(result).toEqual({ status: 'preview' });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('editChildAction', () => {
  it('updates a child scoped to the family and audits child_updated with before/after', async () => {
    const before = { name: 'Robin', dateOfBirth: '2024-01-01' };
    const { tx, inserts, updates } = makeTx([before]);
    fakeDbHandle = txDb(tx);

    const result = await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-02-02' });

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.children)).toEqual({ name: 'Robyn', dateOfBirth: '2024-02-02' });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'child_updated',
      targetId: CHILD_ID,
      before,
      after: { name: 'Robyn', dateOfBirth: '2024-02-02' },
    });
  });

  it('returns not_found and writes nothing when the child is not in the caller family (rule #1)', async () => {
    const { tx, inserts, updates } = makeTx([]); // scoped select finds nothing
    fakeDbHandle = txDb(tx);

    const result = await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-02-02' });

    expect(result).toEqual({ status: 'not_found' });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an invalid edit before resolving the family', async () => {
    fakeDbHandle = {};
    const result = await editChildAction(CHILD_ID, { name: '', dateOfBirth: '2024-02-02' });
    expect(result).toEqual({ status: 'invalid', error: 'name_required' });
    expect(resolveFamilyForUser).not.toHaveBeenCalled();
  });
});

describe('setAreaAction', () => {
  it('updates the area and audits family_area_updated with before/after', async () => {
    const { tx, inserts, updates } = makeTx([{ areaCoarse: 'M4L' }]);
    fakeDbHandle = txDb(tx);

    const result = await setAreaAction('  M6K ');

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({ areaCoarse: 'M6K' });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'family_area_updated',
      targetTable: 'families',
      targetId: FAMILY_ID,
      before: { areaCoarse: 'M4L' },
      after: { areaCoarse: 'M6K' },
    });
  });

  it('clears the area to null on empty input', async () => {
    const { tx, updates } = makeTx([{ areaCoarse: 'M4L' }]);
    fakeDbHandle = txDb(tx);

    const result = await setAreaAction('   ');

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({ areaCoarse: null });
  });
});

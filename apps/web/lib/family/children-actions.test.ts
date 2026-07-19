import { schema } from '@hale/db';
import { revalidatePath } from 'next/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { provisionAndWriteChildren } from '~/lib/onboarding/persist';
import {
  addChildAction,
  editChildAction,
  removeChildAction,
  setIntentsAction,
  setLocationAction,
  setParentNameAction,
  setPlanAction,
} from './children-actions.js';

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
 * Fake tx whose .insert/.update/.delete/.select record their payloads and resolve
 * as the action expects. selectRows seeds the pre-mutation read (existing child /
 * family).
 */
function makeTx(selectRows: unknown[]) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];

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
    delete: vi.fn((table: unknown) => {
      deletes.push({ table });
      return builder([]);
    }),
    select: vi.fn(() => builder(selectRows)),
  };

  return { tx, inserts, updates, deletes };
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

  it('provisions a family (the audited onboarding path) when the parent has none yet, threading the typed interests through', async () => {
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);
    vi.mocked(provisionAndWriteChildren).mockResolvedValue({ familyId: FAMILY_ID });
    const { tx } = makeTx([]);
    fakeDbHandle = txDb(tx);

    const result = await addChildAction({
      name: 'Robin',
      dateOfBirth: '2024-01-01',
      interests: 'swimming, music',
    });

    expect(result).toEqual({ status: 'added' });
    // Provisioning runs INSIDE the caller's transaction (it no longer owns its
    // own), so the family + child + audit rows commit atomically with it.
    expect(
      (fakeDbHandle as { transaction: ReturnType<typeof vi.fn> }).transaction,
    ).toHaveBeenCalledTimes(1);
    expect(provisionAndWriteChildren).toHaveBeenCalledTimes(1);
    // A first-time parent's typed interests must NOT vanish: they thread through
    // the provisioning path onto the child, not just the existing-family path.
    expect(provisionAndWriteChildren).toHaveBeenCalledWith(tx, expect.anything(), [
      {
        name: 'Robin',
        lastName: null,
        dateOfBirth: '2024-01-01',
        gender: 'unspecified',
        interests: ['swimming', 'music'],
      },
    ]);
  });

  it('returns preview (no write) when auth is unconfigured', async () => {
    configureAuth(false);
    const transaction = vi.fn();
    fakeDbHandle = { transaction };
    const result = await addChildAction({ name: 'Robin', dateOfBirth: '2024-01-01' });
    expect(result).toEqual({ status: 'preview' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns unauthenticated (NOT preview) when auth is configured but there is no session', async () => {
    // A real signed-out user on a configured deploy must be told to sign in again,
    // not shown the dev-preview message. The two boundaries are distinct.
    authMock.mockResolvedValue(null);
    const transaction = vi.fn();
    fakeDbHandle = { transaction };
    const result = await addChildAction({ name: 'Robin', dateOfBirth: '2024-01-01' });
    expect(result).toEqual({ status: 'unauthenticated' });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('editChildAction', () => {
  it('updates a child scoped to the family and audits child_updated with before/after', async () => {
    const before = {
      name: 'Robin',
      lastName: null,
      dateOfBirth: '2024-01-01',
      gender: 'unspecified',
      interests: [],
    };
    const { tx, inserts, updates } = makeTx([before]);
    fakeDbHandle = txDb(tx);

    const result = await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-02-02' });

    expect(result).toEqual({ status: 'updated' });
    // PARTIAL update: an edit that sends only name + DOB writes ONLY name + DOB.
    // Absent optional keys must not become validated defaults — that would wipe
    // gender/lastName/interests a parent set elsewhere (e.g. on mobile).
    expect(valuesFor(updates, schema.children)).toEqual({
      name: 'Robyn',
      dateOfBirth: '2024-02-02',
    });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'child_updated',
      targetId: CHILD_ID,
      before,
      after: {
        name: 'Robyn',
        dateOfBirth: '2024-02-02',
      },
    });
    const audited = valuesFor(inserts, schema.auditLog) as { after: Record<string, unknown> };
    expect(audited.after).not.toHaveProperty('gender');
    expect(audited.after).not.toHaveProperty('interests');
  });

  it('persists biologicalSex normalized to male/female when sent, and clears it on "prefer not to say"', async () => {
    const before = {
      name: 'Robin',
      lastName: null,
      dateOfBirth: '2024-01-01',
      gender: 'unspecified',
      biologicalSex: null,
      interests: [],
    };
    const setMale = makeTx([before]);
    fakeDbHandle = txDb(setMale.tx);
    await editChildAction(CHILD_ID, { name: 'Robin', dateOfBirth: '2024-01-01', biologicalSex: 'Male' });
    // Free-text 'Male' normalises to the exact token the WHO read consumes.
    expect(valuesFor(setMale.updates, schema.children)).toMatchObject({ biologicalSex: 'male' });

    // "Prefer not to say" (empty) is a real edit that CLEARS the stored value → null,
    // returning the Growth tab to its honest needs-details state.
    const clear = makeTx([{ ...before, biologicalSex: 'female' }]);
    fakeDbHandle = txDb(clear.tx);
    await editChildAction(CHILD_ID, { name: 'Robin', dateOfBirth: '2024-01-01', biologicalSex: '' });
    expect(valuesFor(clear.updates, schema.children)).toMatchObject({ biologicalSex: null });
  });

  it('does NOT write biologicalSex when the edit omits it (partial update preserves the stored value)', async () => {
    const before = {
      name: 'Robin',
      lastName: null,
      dateOfBirth: '2024-01-01',
      gender: 'unspecified',
      biologicalSex: 'female',
      interests: [],
    };
    const { tx, updates } = makeTx([before]);
    fakeDbHandle = txDb(tx);
    await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-01-01' });
    expect(valuesFor(updates, schema.children)).not.toHaveProperty('biologicalSex');
  });

  it('preserves stored gender/lastName/interests when the edit sends only name + DOB', async () => {
    // The web /family rename flow sends exactly {name, dateOfBirth}. A child
    // whose gender + interests were set on mobile must come through unwiped.
    const before = {
      name: 'Robin',
      lastName: 'Vega',
      dateOfBirth: '2024-01-01',
      gender: 'girl',
      interests: ['music', 'water play'],
    };
    const { tx, updates } = makeTx([before]);
    fakeDbHandle = txDb(tx);

    const result = await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-01-01' });

    expect(result).toEqual({ status: 'updated' });
    const written = valuesFor(updates, schema.children) as Record<string, unknown>;
    expect(written).toEqual({ name: 'Robyn', dateOfBirth: '2024-01-01' });
    // The wipe would show up as explicit defaults here:
    expect(written).not.toHaveProperty('gender');
    expect(written).not.toHaveProperty('lastName');
    expect(written).not.toHaveProperty('interests');
  });

  it('persists gender, lastName, and interests too — not just name + DOB (masked-input bug, CLAUDE.md #8)', async () => {
    const before = {
      name: 'Robin',
      lastName: null,
      dateOfBirth: '2024-01-01',
      gender: 'unspecified',
      interests: [],
    };
    const { tx, inserts, updates } = makeTx([before]);
    fakeDbHandle = txDb(tx);

    const result = await editChildAction(CHILD_ID, {
      name: 'Robyn',
      lastName: 'Vega',
      dateOfBirth: '2024-02-02',
      gender: 'girl',
      interests: 'swimming, music',
    });

    expect(result).toEqual({ status: 'updated' });
    // The .set must write EVERY editable field the input carries — the old code
    // silently dropped gender/lastName/interests.
    expect(valuesFor(updates, schema.children)).toEqual({
      name: 'Robyn',
      lastName: 'Vega',
      dateOfBirth: '2024-02-02',
      gender: 'girl',
      interests: ['swimming', 'music'],
    });
    // The audit after-snapshot reflects the full new state (rule #6).
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      actionTaken: 'child_updated',
      after: {
        name: 'Robyn',
        lastName: 'Vega',
        dateOfBirth: '2024-02-02',
        gender: 'girl',
        interests: ['swimming', 'music'],
      },
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

describe('removeChildAction', () => {
  it('deletes a child scoped to the family and audits child_removed with the before snapshot', async () => {
    const before = { name: 'Robin', dateOfBirth: '2024-01-01' };
    const { tx, inserts, deletes } = makeTx([before]);
    fakeDbHandle = txDb(tx);

    const result = await removeChildAction(CHILD_ID);

    expect(result).toEqual({ status: 'removed' });
    expect(deletes).toEqual([{ table: schema.children }]);
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'child_removed',
      targetTable: 'children',
      targetId: CHILD_ID,
      before,
    });
  });

  it('returns not_found and deletes nothing when the child is not in the caller family (rule #1)', async () => {
    const { tx, inserts, deletes } = makeTx([]); // scoped select finds nothing
    fakeDbHandle = txDb(tx);

    const result = await removeChildAction(CHILD_ID);

    expect(result).toEqual({ status: 'not_found' });
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('setLocationAction', () => {
  it('writes the structured location, derives a coarse FSA for area_coarse, and audits before/after', async () => {
    const existing = {
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M4L 1A1',
      areaCoarse: 'M4L',
    };
    const { tx, inserts, updates } = makeTx([existing]);
    fakeDbHandle = txDb(tx);

    const result = await setLocationAction({
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: ' m6k 3p6 ',
    });

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M6K 3P6',
      // areaCoarse is the DERIVED FSA only — never the full postal code (rule #1).
      areaCoarse: 'M6K',
    });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'family_location_updated',
      targetTable: 'families',
      targetId: FAMILY_ID,
      before: existing,
    });
  });

  it('clears every field to null on empty input (opt-out of local discovery)', async () => {
    const { tx, updates } = makeTx([{ country: 'Canada', province: null, city: null, postalCode: 'M4L', areaCoarse: 'M4L' }]);
    fakeDbHandle = txDb(tx);

    const result = await setLocationAction({});

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({
      country: null,
      province: null,
      city: null,
      postalCode: null,
      areaCoarse: null,
    });
  });
});

describe('setPlanAction', () => {
  it('updates the plan tier and audits family_plan_updated with before/after', async () => {
    const { tx, inserts, updates } = makeTx([{ planTier: 'free' }]);
    fakeDbHandle = txDb(tx);

    const result = await setPlanAction('plus');

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({ planTier: 'plus' });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: FAMILY_ID,
      before: { planTier: 'free' },
      after: { planTier: 'plus' },
    });
  });

  it('rejects an unknown plan tier without touching the db', async () => {
    fakeDbHandle = {};
    const result = await setPlanAction('enterprise');
    expect(result).toEqual({ status: 'invalid' });
    expect(resolveFamilyForUser).not.toHaveBeenCalled();
  });
});

describe('setIntentsAction', () => {
  it('writes validated intents (unknown dropped, canonical order) and audits before/after', async () => {
    const { tx, inserts, updates } = makeTx([{ intents: ['planning'] }]);
    fakeDbHandle = txDb(tx);

    // out of order + an unknown value the action must drop
    const result = await setIntentsAction(['health', 'activities', 'groceries']);

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({ intents: ['activities', 'health'] });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'family_intents_updated',
      targetTable: 'families',
      targetId: FAMILY_ID,
      before: { intents: ['planning'] },
      after: { intents: ['activities', 'health'] },
    });
  });

  it('clears intents to null on an empty selection (optional, defaults to none)', async () => {
    const { tx, updates } = makeTx([{ intents: ['planning'] }]);
    fakeDbHandle = txDb(tx);

    const result = await setIntentsAction([]);

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.families)).toEqual({ intents: null });
  });

  it('returns preview (no write) when auth is unconfigured', async () => {
    configureAuth(false);
    const transaction = vi.fn();
    fakeDbHandle = { transaction };

    const result = await setIntentsAction(['activities']);

    expect(result).toEqual({ status: 'preview' });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('setParentNameAction', () => {
  it('updates the users name (trimmed) and audits parent_name_updated with before/after', async () => {
    const { tx, inserts, updates } = makeTx([{ name: 'Avery' }]);
    fakeDbHandle = txDb(tx);

    const result = await setParentNameAction('  Avery Q  ');

    expect(result).toEqual({ status: 'updated' });
    expect(valuesFor(updates, schema.users)).toEqual({ name: 'Avery Q' });
    expect(valuesFor(inserts, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'parent_name_updated',
      targetTable: 'users',
      targetId: USER_ID,
      before: { name: 'Avery' },
      after: { name: 'Avery Q' },
    });
  });

  it('rejects an empty name without touching the db', async () => {
    fakeDbHandle = {};
    const result = await setParentNameAction('   ');
    expect(result).toEqual({ status: 'invalid' });
    expect(resolveFamilyForUser).not.toHaveBeenCalled();
  });
});

describe('IA split — each mutation revalidates the page that renders it', () => {
  // Family control (children, household location, tailoring intents) is
  // server-rendered on /family/members (the editor), NOT the /family hub (a nav
  // index of tiles). Account config (profile name, plan) lives on /settings. A
  // write must revalidate the page it actually appears on, or the moved surface
  // serves stale cached HTML until a hard reload.
  it('revalidates /family/members for an added child', async () => {
    const { tx } = makeTx([]);
    fakeDbHandle = txDb(tx);
    await addChildAction({ name: 'Robin', dateOfBirth: '2024-01-01' });
    expect(revalidatePath).toHaveBeenCalledWith('/family/members');
    expect(revalidatePath).not.toHaveBeenCalledWith('/settings');
  });

  it('revalidates /family/members for an edited child', async () => {
    const { tx } = makeTx([{ name: 'Robin', dateOfBirth: '2024-01-01' }]);
    fakeDbHandle = txDb(tx);
    await editChildAction(CHILD_ID, { name: 'Robyn', dateOfBirth: '2024-02-02' });
    expect(revalidatePath).toHaveBeenCalledWith('/family/members');
    expect(revalidatePath).not.toHaveBeenCalledWith('/settings');
  });

  it('revalidates /family/members for a removed child', async () => {
    const { tx } = makeTx([{ name: 'Robin', dateOfBirth: '2024-01-01' }]);
    fakeDbHandle = txDb(tx);
    await removeChildAction(CHILD_ID);
    expect(revalidatePath).toHaveBeenCalledWith('/family/members');
    expect(revalidatePath).not.toHaveBeenCalledWith('/settings');
  });

  it('revalidates /family/members for a household location change', async () => {
    const { tx } = makeTx([{ country: null, province: null, city: null, postalCode: null, areaCoarse: null }]);
    fakeDbHandle = txDb(tx);
    await setLocationAction({ city: 'Toronto' });
    expect(revalidatePath).toHaveBeenCalledWith('/family/members');
    expect(revalidatePath).not.toHaveBeenCalledWith('/settings');
  });

  it('revalidates /family/members for a tailoring-intents change', async () => {
    const { tx } = makeTx([{ intents: null }]);
    fakeDbHandle = txDb(tx);
    await setIntentsAction(['activities']);
    expect(revalidatePath).toHaveBeenCalledWith('/family/members');
    expect(revalidatePath).not.toHaveBeenCalledWith('/settings');
  });

  it('revalidates /settings for a plan change (account config, not family)', async () => {
    const { tx } = makeTx([{ planTier: 'free' }]);
    fakeDbHandle = txDb(tx);
    await setPlanAction('plus');
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
    expect(revalidatePath).not.toHaveBeenCalledWith('/family/members');
  });

  it('revalidates /settings for a profile-name change (account config, not family)', async () => {
    const { tx } = makeTx([{ name: 'Avery' }]);
    fakeDbHandle = txDb(tx);
    await setParentNameAction('Avery Q');
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
    expect(revalidatePath).not.toHaveBeenCalledWith('/family/members');
  });
});

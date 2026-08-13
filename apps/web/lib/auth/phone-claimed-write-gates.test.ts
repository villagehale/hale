import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A phone-claimed session can WRITE.
 *
 * A family that arrived by text has `users.email = NULL` by construction — the phone
 * number IS the account (channel/intake/provision.ts). Six authed write surfaces used
 * to refuse those sessions outright, because each one gated on `session.user.email`
 * before doing anything. That gate was never load-bearing: every one of them resolves
 * the FAMILY first, and resolveFamilyForUser is an inner join starting FROM the users
 * table, so a non-null familyId already proves the users row exists. The email was only
 * ever read on a create path none of these six can reach.
 *
 * This file is the invariant stated once, across all six, because "a phone-claimed
 * parent can change their own settings" is one property and reading six separate
 * assertions of it in six files is how one quietly regresses. Each case drives a real
 * exported WRITE with an email-less session and asserts it gets past the door.
 *
 * The db is a permissive capturing fake: these tests are about the GATE, not about what
 * each writer persists (that is each lib's own suite). What matters is that none of them
 * answers `unauthenticated` to a parent who is, in fact, authenticated.
 */

const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
// Two Next request-scope APIs these writers reach only AFTER the gate has opened —
// mocked so a passing test is about the door rather than about vitest lacking a request.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const resolveFamilyMock = vi.fn();
const requireUserIdMock = vi.fn();
const ensureUserRowMock = vi.fn();
const resolveUserIdMock = vi.fn();
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  requireUserIdForUser: (...a: unknown[]) => requireUserIdMock(...a),
  ensureUserRow: (...a: unknown[]) => ensureUserRowMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
  loadViewerName: vi.fn(async () => null),
}));

/** Accepts any query, returns nothing, records nothing. The gate is the subject. */
function permissiveDb(): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'where',
    'orderBy',
    'limit',
    'set',
    'values',
    'returning',
    'onConflictDoUpdate',
    'onConflictDoNothing',
    'innerJoin',
    'leftJoin',
    'groupBy',
  ]) {
    chain[m] = () => chain;
  }
  // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
  const handle = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    execute: async () => [],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
  };
  return handle;
}
vi.mock('~/lib/db', () => ({ db: () => permissiveDb() }));

/** Exactly what a claim-by-phone session carries: a subject, and no address. */
const PHONE_CLAIMED = { user: { id: 'sms:9f2c4e1a', name: null } };

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  authMock.mockReset().mockResolvedValue(PHONE_CLAIMED);
  resolveFamilyMock.mockReset().mockResolvedValue('fam-1');
  requireUserIdMock.mockReset().mockResolvedValue('user-1');
  ensureUserRowMock.mockReset().mockResolvedValue('user-1');
  resolveUserIdMock.mockReset().mockResolvedValue('user-1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The statuses that mean "the door was shut on a signed-in parent". */
function assertGotThroughTheDoor(result: { status: string }) {
  expect(result.status).not.toBe('unauthenticated');
  expect(result.status).not.toBe('preview');
}

describe('a phone-claimed session (email NULL) can write its settings', () => {
  it('can change a loop notification preference', async () => {
    const { setLoopPref } = await import('~/lib/settings/loop-prefs');

    const result = await setLoopPref({ field: 'catReminder', value: false });

    assertGotThroughTheDoor(result);
  });

  it('can change the daily-brief email preference', async () => {
    const { setNotificationPrefAction } = await import('~/lib/settings/notification-prefs');

    const result = await setNotificationPrefAction('dailyBriefEmail', false);

    assertGotThroughTheDoor(result);
  });

  it('can change a push notification preference', async () => {
    const { setPushNotificationPref } = await import('~/lib/settings/push-notification-prefs');

    const result = await setPushNotificationPref('pushNewPicks', false);

    assertGotThroughTheDoor(result);
  });

  it('can change the family plan tier', async () => {
    const { setPlanAction } = await import('~/lib/family/children-actions');

    const result = await setPlanAction('free');

    assertGotThroughTheDoor(result);
  });

  it('can delete one of its own plans', async () => {
    const { deletePlan } = await import('~/lib/plan/plan-actions');

    const result = await deletePlan('plan-1');

    assertGotThroughTheDoor(result);
  });

  it('can revoke its own SMS channel — the one every phone family will reach for', async () => {
    const { revokeSmsChannelForUser } = await import('~/lib/channels/sms-consent');

    const result = await revokeSmsChannelForUser();

    assertGotThroughTheDoor(result);
  });
});

describe('the gate still shuts on a session that has no subject', () => {
  it('refuses a signed-out caller', async () => {
    authMock.mockResolvedValue(null);
    const { setPushNotificationPref } = await import('~/lib/settings/push-notification-prefs');

    const result = await setPushNotificationPref('pushNewPicks', false);

    expect(result.status).toBe('unauthenticated');
  });

  it('refuses a session carrying an email but no subject — an id is what identifies', async () => {
    authMock.mockResolvedValue({ user: { email: 'p@example.com' } });
    const { setPushNotificationPref } = await import('~/lib/settings/push-notification-prefs');

    const result = await setPushNotificationPref('pushNewPicks', false);

    expect(result.status).toBe('unauthenticated');
  });
});

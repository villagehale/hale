import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authConfig } from '~/auth.config';
import { hashOtpCode } from '~/lib/channels/otp';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';

/**
 * The claim chokepoint — everything that must be true for a text-onboarded parent to
 * end up holding a session, and for nobody else to.
 *
 * THE ANTI-FORK ASSERTION lives here: the identity authorize resolves is carried
 * through the REAL jwt callback (imported from auth.config, not restated) and must come
 * out as a `sub` equal to the external_auth_id the account already had — with no users
 * row written along the way.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+15195551234';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CODE = '428913';
const EXISTING_IDENTITY = () => `sms:${phoneBlindIndex(PHONE)}`;

const authRateLimitedMock = vi.fn(async () => false);
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => authRateLimitedMock(),
}));

let rows: { channels?: unknown[]; members?: unknown[]; verifications?: unknown[]; users?: unknown[] } = {};
const writes: Array<{ table: unknown }> = [];

function thenable(result: unknown[], table: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'orderBy', 'from']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  c.returning = vi.fn(() => Promise.resolve(result));
  c.set = vi.fn(() => {
    writes.push({ table });
    return c;
  });
  c.values = vi.fn(() => {
    writes.push({ table });
    return c;
  });
  // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

function rowsFor(table: unknown): unknown[] {
  if (table === schema.parentChannels) return rows.channels ?? [];
  if (table === schema.familyMembers) return rows.members ?? [];
  if (table === schema.phoneVerifications) return rows.verifications ?? [];
  if (table === schema.users) return rows.users ?? [];
  return [];
}

const fakeDb = {
  select: () => ({ from: (table: unknown) => thenable(rowsFor(table), table) }),
  update: (table: unknown) => thenable(rowsFor(table), table),
  insert: (table: unknown) => thenable(rowsFor(table), table),
  transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(fakeDb),
};
vi.mock('~/lib/db', () => ({ db: () => fakeDb }));

/** A claimable text-onboarded parent holding a live code for their own number. */
function claimableParent(role = 'primary_parent') {
  return {
    channels: [
      {
        userId: USER_ID,
        familyId: FAMILY_ID,
        id: '55555555-5555-4555-8555-555555555555',
        phoneE164Hash: phoneBlindIndex(PHONE),
        verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
        revokedAt: null,
      },
    ],
    members: [{ familyId: FAMILY_ID, userId: USER_ID, role }],
    verifications: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        phoneE164Encrypted: encryptString(PHONE),
        codeHash: hashOtpCode(CODE),
        expiresAt: new Date(Date.now() + 60_000),
        attemptCount: 0,
      },
    ],
    users: [{ id: USER_ID, externalAuthId: EXISTING_IDENTITY() }],
  };
}

async function authorize(raw: Record<string, unknown> | undefined) {
  const { authorizeClaimByPhone } = await import('~/lib/auth/claim-phone-authorize');
  return authorizeClaimByPhone(raw);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  process.env.F14_RECEIPTS_IA = 'true';
  rows = {};
  writes.length = 0;
  authRateLimitedMock.mockResolvedValue(false);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  process.env.F14_RECEIPTS_IA = '';
  vi.restoreAllMocks();
});

describe('authorizeClaimByPhone', () => {
  it('resolves the session to the EXISTING identity, creating no second account', async () => {
    rows = claimableParent();

    const identity = await authorize({ phone: PHONE, code: CODE });

    expect(identity).toEqual({ id: EXISTING_IDENTITY(), email: null });
    expect(writes.some((w) => w.table === schema.users)).toBe(false);
  });

  it('carries that identity through the REAL jwt callback as the session subject', async () => {
    rows = claimableParent();
    const identity = await authorize({ phone: PHONE, code: CODE });
    if (!identity) throw new Error('expected a claim');

    const jwt = authConfig.callbacks.jwt;
    const token = await jwt({
      token: { sub: 'a-stale-subject' },
      user: identity,
      account: { provider: 'claim-phone', type: 'credentials', providerAccountId: 'ignored' },
      // biome-ignore lint/suspicious/noExplicitAny: exercising the callback's real signature
    } as any);

    // The whole point: the session's subject is the sms identity the intake minted,
    // so resolveFamilyForUser finds the family that already exists.
    expect(token?.sub).toBe(EXISTING_IDENTITY());
    expect(authConfig.callbacks.session({ session: { user: {} }, token } as never)).toMatchObject({
      user: { id: EXISTING_IDENTITY() },
    });
  });

  it('refuses a caregiver holding a valid code, with the same null every failure gives', async () => {
    rows = claimableParent('nanny');

    expect(await authorize({ phone: PHONE, code: CODE })).toBeNull();
  });

  it('refuses a wrong code, an unknown number, and a missing field alike', async () => {
    rows = claimableParent();
    expect(await authorize({ phone: PHONE, code: '000000' })).toBeNull();

    rows = { channels: [] };
    expect(await authorize({ phone: PHONE, code: CODE })).toBeNull();

    rows = claimableParent();
    expect(await authorize({ phone: PHONE })).toBeNull();
    expect(await authorize({ code: CODE })).toBeNull();
    expect(await authorize(undefined)).toBeNull();
  });

  it('is closed while the flag is dark, even with a perfect code', async () => {
    process.env.F14_RECEIPTS_IA = '';
    rows = claimableParent();

    expect(await authorize({ phone: PHONE, code: CODE })).toBeNull();
    expect(writes).toEqual([]); // dark means the code isn't even spent
  });

  it('is throttled by the shared per-IP auth window', async () => {
    authRateLimitedMock.mockResolvedValue(true);
    rows = claimableParent();

    expect(await authorize({ phone: PHONE, code: CODE })).toBeNull();
    expect(writes).toEqual([]);
  });

  it('never logs the number or the code when it refuses', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    rows = claimableParent('babysitter');

    await authorize({ phone: PHONE, code: CODE });

    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('not_a_parent');
    expect(logged).not.toContain('5195551234');
    expect(logged).not.toContain(CODE);
  });
});

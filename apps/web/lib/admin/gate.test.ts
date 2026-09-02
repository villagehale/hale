import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * The /admin gate, run for real against a table-keyed DB fake. What matters:
 * only a session whose users row owns an ACTIVE VERIFIED sms channel hashing
 * into ADMIN_PHONES is an admin, and every other state — unset allowlist,
 * revoked channel, unverified channel, verified-but-unlisted parent, no
 * session — resolves to its own named refusal (never a throw, never open).
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const ADMIN_PHONE = '+14165551234';
const OTHER_PHONE = '+15195559876';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_ID = 'sms:abc123';

let sessionUserId: string | null = EXTERNAL_ID;
vi.mock('~/auth', () => ({
  auth: async () => (sessionUserId ? { user: { id: sessionUserId } } : null),
}));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));

let rows: { users?: unknown[]; channels?: unknown[] } = {};

function thenable(result: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'orderBy', 'from']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

function rowsFor(table: unknown): unknown[] {
  if (table === schema.users) return rows.users ?? [];
  if (table === schema.parentChannels) return rows.channels ?? [];
  return [];
}

const fakeDb = {
  select: () => ({ from: (table: unknown) => thenable(rowsFor(table)) }),
} as never;

vi.mock('~/lib/db', () => ({
  db: () => {
    throw new Error('gate tests must inject the fake db');
  },
}));

function activeChannel(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    kind: 'sms',
    phoneE164Hash: phoneBlindIndex(ADMIN_PHONE),
    verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

async function gate() {
  const { resolveAdminGate } = await import('./gate');
  return resolveAdminGate(fakeDb);
}

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  process.env.ADMIN_PHONES = ADMIN_PHONE;
  sessionUserId = EXTERNAL_ID;
  rows = {
    users: [{ id: USER_ID, externalAuthId: EXTERNAL_ID }],
    channels: [activeChannel()],
  };
  const { resetAdminGateAbsenceLogForTests } = await import('./gate');
  resetAdminGateAbsenceLogForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  process.env.ADMIN_PHONES = '';
  vi.restoreAllMocks();
});

describe('resolveAdminGate', () => {
  it('admits the allowlisted parent by blind-index match', async () => {
    expect(await gate()).toEqual({ status: 'admin', userId: USER_ID });
  });

  it('admits when the allowlist entry is formatted loosely (spaces, no +1)', async () => {
    process.env.ADMIN_PHONES = ' 416 555 1234 , +15005550000';
    expect(await gate()).toEqual({ status: 'admin', userId: USER_ID });
  });

  it('refuses a verified parent whose number is not on the allowlist', async () => {
    rows.channels = [activeChannel({ phoneE164Hash: phoneBlindIndex(OTHER_PHONE) })];
    expect(await gate()).toEqual({ status: 'not_admin' });
  });

  it('refuses a REVOKED channel even when the hash matches', async () => {
    rows.channels = [activeChannel({ revokedAt: new Date('2026-08-10T00:00:00.000Z') })];
    expect(await gate()).toEqual({ status: 'not_admin' });
  });

  it('refuses an UNVERIFIED channel even when the hash matches', async () => {
    rows.channels = [activeChannel({ verifiedAt: null })];
    expect(await gate()).toEqual({ status: 'not_admin' });
  });

  it('refuses a session with no mirrored users row', async () => {
    rows.users = [];
    expect(await gate()).toEqual({ status: 'not_admin' });
  });

  it('is unauthenticated with no session', async () => {
    sessionUserId = null;
    expect(await gate()).toEqual({ status: 'unauthenticated' });
  });

  it('fails CLOSED for everyone when ADMIN_PHONES is unset, and logs the absence once', async () => {
    process.env.ADMIN_PHONES = '';
    expect(await gate()).toEqual({ status: 'not_configured' });
    expect(await gate()).toEqual({ status: 'not_configured' });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when ADMIN_PHONES holds only garbage entries', async () => {
    process.env.ADMIN_PHONES = 'not-a-number, 123';
    expect(await gate()).toEqual({ status: 'not_configured' });
  });
});

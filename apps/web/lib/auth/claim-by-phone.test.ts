import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOtpSender } from '~/lib/channels/otp-sender';
import { OTP_MAX_ATTEMPTS, hashOtpCode } from '~/lib/channels/otp';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { requestClaimCode, verifyClaimCode } from './claim-by-phone';

/**
 * The claim-by-phone core: a family that arrived by TEXT proving it owns the account
 * the web app already holds for its number. Every test here is really one of two
 * questions — "did anything leave" (a code, a session) and "who did it leave for".
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+15195551234';
const OTHER_PHONE = '+15195559876';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555';
const VERIFICATION_ID = '66666666-6666-4666-8666-666666666666';
const CODE = '428913';
const NOW = new Date('2026-08-12T12:00:00.000Z');

/** The identity a text-onboarded family already has (provision.ts mints exactly this). */
function smsExternalAuthId(): string {
  return `sms:${phoneBlindIndex(PHONE)}`;
}

interface Rows {
  channels?: unknown[];
  members?: unknown[];
  verifications?: unknown[];
  users?: unknown[];
}

/**
 * A chainable Drizzle fake keyed by TABLE, mirroring channels/sms-consent-core.test.ts.
 * Reads resolve per table; writes are recorded in call order so a test can assert both
 * what was written and what was NOT (no users row — the anti-fork assertion).
 */
function makeFakeDb(rows: Rows) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; payload: unknown }> = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.parentChannels) return rows.channels ?? [];
    if (table === schema.familyMembers) return rows.members ?? [];
    if (table === schema.phoneVerifications) return rows.verifications ?? [];
    if (table === schema.users) return rows.users ?? [];
    return [];
  };

  const chain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'from', 'onConflictDoNothing', 'innerJoin']) {
      c[m] = vi.fn(() => c);
    }
    c.limit = vi.fn(() => Promise.resolve(result));
    c.returning = vi.fn(() => Promise.resolve(result));
    // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return c;
  };

  const handle = {
    select: vi.fn(() => ({ from: (table: unknown) => chain(rowsFor(table)) })),
    update: vi.fn((table: unknown) => {
      const c = chain(rowsFor(table));
      c.set = vi.fn((payload: unknown) => {
        writes.push({ op: 'update', table, payload });
        return c;
      });
      return c;
    }),
    insert: vi.fn((table: unknown) => {
      const c = chain(rowsFor(table));
      c.values = vi.fn((payload: unknown) => {
        writes.push({ op: 'insert', table, payload });
        return c;
      });
      return c;
    }),
  };

  const db = {
    ...handle,
    transaction: vi.fn(async (cb: (t: typeof handle) => Promise<unknown>) => cb(handle)),
  } as unknown as Database;

  return { db, writes };
}

/** An ACTIVE, verified channel row for PHONE — what a text-onboarded family has. */
function activeChannel(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    familyId: FAMILY_ID,
    id: CHANNEL_ID,
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

function member(role: string) {
  return { familyId: FAMILY_ID, userId: USER_ID, role };
}

/** A live, unconsumed code for PHONE. */
function pendingCode(overrides: Record<string, unknown> = {}) {
  return {
    id: VERIFICATION_ID,
    phoneE164Encrypted: encryptString(PHONE),
    codeHash: hashOtpCode(CODE),
    expiresAt: new Date(NOW.getTime() + 60_000),
    attemptCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('requestClaimCode', () => {
  it('sends a code to a parent whose number holds an active verified channel', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
    });

    const result = await requestClaimCode(
      db,
      { phoneRaw: '(519) 555-1234', now: NOW },
      { sender, generateCode: () => CODE },
    );

    expect(result).toEqual({ status: 'sent' });
    expect(sender.sent).toEqual([{ phoneE164: PHONE, code: CODE }]);
    const inserted = writes.find(
      (w) => w.op === 'insert' && w.table === schema.phoneVerifications,
    )?.payload as Record<string, unknown> | undefined;
    expect(inserted?.userId).toBe(USER_ID);
    expect(inserted?.codeHash).toBe(hashOtpCode(CODE));
    expect(inserted?.codeHash).not.toBe(CODE);
  });

  it('sends NOTHING for a number with no account, and says so as its own outcome', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({ channels: [] });

    const result = await requestClaimCode(db, { phoneRaw: PHONE, now: NOW }, { sender });

    expect(result).toEqual({ status: 'no_claimable_account' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('sends NOTHING to a number that texted STOP (revoked channel)', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({
      // The row exists but is revoked. The resolver's own re-check must drop it — a
      // parent who opted out cannot be texted, not even a code they asked for.
      channels: [activeChannel({ revokedAt: new Date('2026-08-05T00:00:00.000Z') })],
      members: [member('primary_parent')],
    });

    const result = await requestClaimCode(db, { phoneRaw: PHONE, now: NOW }, { sender });

    expect(result).toEqual({ status: 'no_claimable_account' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('sends NOTHING to a caregiver number, whatever its channel says', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('nanny')],
    });

    const result = await requestClaimCode(db, { phoneRaw: PHONE, now: NOW }, { sender });

    expect(result).toEqual({ status: 'not_a_parent' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('sends NOTHING to a legacy `extended` role — the positive list, not "not a caregiver"', async () => {
    const sender = new FakeOtpSender();
    const { db } = makeFakeDb({ channels: [activeChannel()], members: [member('extended')] });

    const result = await requestClaimCode(db, { phoneRaw: PHONE, now: NOW }, { sender });

    expect(result).toEqual({ status: 'not_a_parent' });
    expect(sender.sent).toEqual([]);
  });

  it('names an unconfigured sender rather than pretending a code is on its way', async () => {
    const sender = new FakeOtpSender({ status: 'not_configured' });
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('co_parent')],
    });

    const result = await requestClaimCode(
      db,
      { phoneRaw: PHONE, now: NOW },
      { sender, generateCode: () => CODE },
    );

    expect(result).toEqual({ status: 'sender_not_configured' });
    expect(writes).toEqual([]); // nothing "pending" that could never be delivered
  });

  it('honours the resend cooldown rather than texting on every tap', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [{ lastSentAt: new Date(NOW.getTime() - 5_000) }],
    });

    const result = await requestClaimCode(db, { phoneRaw: PHONE, now: NOW }, { sender });

    expect(result).toEqual({ status: 'cooldown' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('refuses a malformed number without a lookup', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({ channels: [activeChannel()] });

    const result = await requestClaimCode(db, { phoneRaw: '555', now: NOW }, { sender });

    expect(result).toEqual({ status: 'invalid_phone' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('verifyClaimCode', () => {
  it('resolves to the EXISTING identity and creates no new user (anti-fork)', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode()],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    const result = await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW });

    // The session subject IS the sms identity the intake already minted. A second
    // identity here is the fork this whole flow exists to prevent.
    expect(result).toEqual({
      status: 'claimed',
      userId: USER_ID,
      familyId: FAMILY_ID,
      externalAuthId: smsExternalAuthId(),
    });
    expect(writes.some((w) => w.table === schema.users)).toBe(false);
  });

  it('burns the code and writes an audit row carrying no phone number', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode()],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW });

    const burn = writes.find(
      (w) => w.op === 'update' && w.table === schema.phoneVerifications,
    )?.payload as Record<string, unknown> | undefined;
    expect(burn?.consumedAt).toEqual(NOW);

    const audit = writes.find((w) => w.op === 'insert' && w.table === schema.auditLog)?.payload as
      | Record<string, unknown>
      | undefined;
    expect(audit?.familyId).toBe(FAMILY_ID);
    expect(audit?.actor).toBe(USER_ID);
    expect(audit?.actionTaken).toBe('account_claimed_by_phone');
    expect(JSON.stringify(audit)).not.toContain('5195551234');
    expect(JSON.stringify(audit)).not.toContain(CODE);
  });

  it('refuses a caregiver holding a genuinely valid code, and leaves the code unburned', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('babysitter')],
      verifications: [pendingCode()],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    const result = await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW });

    expect(result).toEqual({ status: 'refused', reason: 'not_a_parent' });
    expect(writes).toEqual([]);
  });

  it('refuses a code minted for a DIFFERENT number than the one being claimed', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      // A live code this user holds — but it was sent to their other handset. It must
      // not authorise a claim on THIS number.
      verifications: [pendingCode({ phoneE164Encrypted: encryptString(OTHER_PHONE) })],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    const result = await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW });

    expect(result).toEqual({ status: 'refused', reason: 'code_not_for_this_number' });
    expect(writes).toEqual([]);
  });

  it('refuses a wrong code and spends an attempt', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode()],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    const result = await verifyClaimCode(db, { phoneRaw: PHONE, code: '000000', now: NOW });

    expect(result).toEqual({ status: 'refused', reason: 'wrong_code' });
    const attempt = writes.find(
      (w) => w.op === 'update' && w.table === schema.phoneVerifications,
    )?.payload as Record<string, unknown> | undefined;
    expect(attempt?.attemptCount).toBe(1);
    expect(attempt?.consumedAt).toBeUndefined();
  });

  it('refuses an expired code', async () => {
    const { db } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode({ expiresAt: new Date(NOW.getTime() - 1) })],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    expect(await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW })).toEqual({
      status: 'refused',
      reason: 'expired',
    });
  });

  it('refuses a code that has already spent its attempts', async () => {
    const { db } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode({ attemptCount: OTP_MAX_ATTEMPTS })],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    expect(await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW })).toEqual({
      status: 'refused',
      reason: 'locked',
    });
  });

  it('refuses when there is no pending code (a consumed one is not re-usable)', async () => {
    const { db } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [],
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId() }],
    });

    expect(await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW })).toEqual({
      status: 'refused',
      reason: 'no_pending_code',
    });
  });

  it('refuses an unknown number without touching any code', async () => {
    const { db, writes } = makeFakeDb({ channels: [] });

    expect(await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW })).toEqual({
      status: 'refused',
      reason: 'no_claimable_account',
    });
    expect(writes).toEqual([]);
  });

  it('refuses when the code is right but the user row lost its identity', async () => {
    const { db, writes } = makeFakeDb({
      channels: [activeChannel()],
      members: [member('primary_parent')],
      verifications: [pendingCode()],
      users: [],
    });

    expect(await verifyClaimCode(db, { phoneRaw: PHONE, code: CODE, now: NOW })).toEqual({
      status: 'refused',
      reason: 'no_identity',
    });
    // Fails closed: no session, and no half-done burn either.
    expect(writes).toEqual([]);
  });
});

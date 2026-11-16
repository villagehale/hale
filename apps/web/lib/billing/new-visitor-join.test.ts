import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashOtpCode } from '~/lib/channels/otp';
import { FakeOtpSender } from '~/lib/channels/otp-sender';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { requestPromoJoinCode, smsExternalAuthId, verifyPromoJoinCode } from './new-visitor-join.js';

const KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+15195551234';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555';
const VERIFICATION_ID = '66666666-6666-4666-8666-666666666666';
const CODE = '428913';
const NOW = new Date('2026-11-16T12:00:00.000Z');

interface Rows {
  channels?: unknown[];
  members?: unknown[];
  verifications?: unknown[];
  users?: unknown[];
  families?: unknown[];
}

function makeFakeDb(rows: Rows) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; payload: unknown }> = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.parentChannels) return rows.channels ?? [];
    if (table === schema.familyMembers) return rows.members ?? [];
    if (table === schema.phoneVerifications) return rows.verifications ?? [];
    if (table === schema.users) return rows.users ?? [];
    if (table === schema.families) return rows.families ?? [];
    if (table === schema.auditLog) return [];
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
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(handle),
    writes,
  };

  return handle;
}

function activeChannel(revokedAt: Date | null = null) {
  return {
    id: CHANNEL_ID,
    userId: USER_ID,
    familyId: FAMILY_ID,
    kind: 'sms',
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: revokedAt ? null : NOW,
    revokedAt,
  };
}

describe('requestPromoJoinCode', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv('PHONE_BLIND_INDEX_KEY', KEY);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('texts an unknown number and upserts the sms identity (no channel)', async () => {
    const db = makeFakeDb({ users: [{ id: USER_ID, externalAuthId: smsExternalAuthId('x') }] });
    const sender = new FakeOtpSender();
    const result = await requestPromoJoinCode(
      db as never,
      { phoneRaw: PHONE, now: NOW },
      { sender, generateCode: () => CODE },
    );
    expect(result).toEqual({ status: 'sent' });
    expect(sender.sent).toEqual([{ phoneE164: PHONE, code: CODE }]);
    expect(db.writes.some((w) => w.table === schema.parentChannels)).toBe(false);
    expect(db.writes.some((w) => w.table === schema.families)).toBe(false);
  });

  it('does not text a STOP’d number', async () => {
    const db = makeFakeDb({
      channels: [activeChannel(NOW)],
    });
    const sender = new FakeOtpSender();
    const result = await requestPromoJoinCode(
      db as never,
      { phoneRaw: PHONE, now: NOW },
      { sender, generateCode: () => CODE },
    );
    expect(result).toEqual({ status: 'stopped' });
    expect(sender.sent).toEqual([]);
  });

  it('does not text a caregiver', async () => {
    const db = makeFakeDb({
      channels: [
        {
          ...activeChannel(),
          verifiedAt: NOW,
          revokedAt: null,
        },
      ],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'nanny' }],
    });
    const sender = new FakeOtpSender();
    const result = await requestPromoJoinCode(
      db as never,
      { phoneRaw: PHONE, now: NOW },
      { sender, generateCode: () => CODE },
    );
    expect(result).toEqual({ status: 'not_a_parent' });
    expect(sender.sent).toEqual([]);
  });
});

describe('verifyPromoJoinCode', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv('PHONE_BLIND_INDEX_KEY', KEY);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('creates a pending family with no channel and names it paid=false', async () => {
    const db = makeFakeDb({
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId(phoneBlindIndex(PHONE)) }],
      verifications: [
        {
          id: VERIFICATION_ID,
          phoneE164Encrypted: encryptString(PHONE),
          codeHash: hashOtpCode(CODE),
          expiresAt: new Date(NOW.getTime() + 60_000),
          attemptCount: 0,
        },
      ],
      families: [{ id: FAMILY_ID, planTier: 'free', stripeSubscriptionId: null }],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    });

    const result = await verifyPromoJoinCode(db as never, {
      phoneRaw: PHONE,
      code: CODE,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'ok',
      familyId: FAMILY_ID,
      userId: USER_ID,
      alreadyPaid: false,
    });
    expect(db.writes.some((w) => w.table === schema.parentChannels)).toBe(false);
    expect(
      db.writes.some(
        (w) =>
          w.table === schema.auditLog &&
          (w.payload as { actionTaken?: string }).actionTaken === 'promo_join_verified',
      ),
    ).toBe(true);
  });

  it('marks alreadyPaid when the reused family is on Plus', async () => {
    const db = makeFakeDb({
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId(phoneBlindIndex(PHONE)) }],
      verifications: [
        {
          id: VERIFICATION_ID,
          phoneE164Encrypted: encryptString(PHONE),
          codeHash: hashOtpCode(CODE),
          expiresAt: new Date(NOW.getTime() + 60_000),
          attemptCount: 0,
        },
      ],
      families: [{ id: FAMILY_ID, planTier: 'plus', stripeSubscriptionId: 'sub_1' }],
      members: [{ familyId: FAMILY_ID, userId: USER_ID, role: 'primary_parent' }],
    });

    const result = await verifyPromoJoinCode(db as never, {
      phoneRaw: PHONE,
      code: CODE,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'ok', alreadyPaid: true });
    expect(
      db.writes.filter(
        (w) =>
          w.table === schema.auditLog &&
          (w.payload as { actionTaken?: string }).actionTaken === 'promo_join_verified',
      ),
    ).toHaveLength(1);
  });

  it('refuses a wrong code', async () => {
    const db = makeFakeDb({
      users: [{ id: USER_ID, externalAuthId: smsExternalAuthId(phoneBlindIndex(PHONE)) }],
      verifications: [
        {
          id: VERIFICATION_ID,
          phoneE164Encrypted: encryptString(PHONE),
          codeHash: hashOtpCode(CODE),
          expiresAt: new Date(NOW.getTime() + 60_000),
          attemptCount: 0,
        },
      ],
    });
    const result = await verifyPromoJoinCode(db as never, {
      phoneRaw: PHONE,
      code: '000000',
      now: NOW,
    });
    expect(result).toEqual({ status: 'refused', reason: 'wrong_code' });
  });
});

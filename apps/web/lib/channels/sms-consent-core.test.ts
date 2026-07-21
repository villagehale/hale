import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeOtpSender } from './otp-sender';
import { hashOtpCode } from './otp';
import { maskPhoneE164 } from './phone';
import {
  SMS_CONSENT_SCOPE,
  requestPhoneOtp,
  resolveVerifiedChannelByPhone,
  revokeSmsChannel,
  verifyPhoneOtp,
} from './sms-consent-core';

const KEY = Buffer.alloc(32, 7).toString('base64');
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const PHONE = '+15195551234';
const CODE = '428913';
const NOW = new Date('2026-07-20T12:00:00.000Z');

/**
 * A generic chainable fake for a Drizzle handle. Records every insert's values and
 * every update's set (in call order across the db AND its tx) so a test can assert
 * both WHAT was written and the ORDER (consent before channel before audit). Reads
 * resolve to `selectRows(table)`; update/insert `.returning()` resolve to
 * `returnRows(table)`; awaiting a chain without a terminal resolves to [].
 */
function makeFakeDb(opts: {
  selectRows?: (table: unknown) => unknown[];
  returnRows?: (table: unknown) => unknown[];
}) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; payload: unknown }> = [];
  const selectRows = opts.selectRows ?? (() => []);
  const returnRows = opts.returnRows ?? (() => []);

  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'from', 'onConflictDoUpdate', 'onConflictDoNothing']) {
      c[m] = vi.fn(() => c);
    }
    c.limit = vi.fn(() => Promise.resolve(rows));
    c.returning = vi.fn(() => Promise.resolve(rows));
    // The real Drizzle query builder is thenable (`await db.update()...` with no
    // terminal resolves the write), so this fake must be too — that's the whole point.
    // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return c;
  };

  const handle = {
    select: vi.fn(() => ({
      from: (table: unknown) => chain(selectRows(table)),
    })),
    update: vi.fn((table: unknown) => {
      const c = chain(returnRows(table));
      c.set = vi.fn((payload: unknown) => {
        writes.push({ op: 'update', table, payload });
        return c;
      });
      return c;
    }),
    insert: vi.fn((table: unknown) => {
      const c = chain(returnRows(table));
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

  return { db, writes, transactionCalled: () => (db as unknown as typeof db).transaction };
}

function writeFor(writes: Array<{ table: unknown; payload: unknown }>, table: unknown) {
  return writes.find((w) => w.table === table)?.payload as Record<string, unknown> | undefined;
}

describe('requestPhoneOtp', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  it('rejects an invalid number without sending or writing', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({});
    const result = await requestPhoneOtp(db, { userId: USER_ID, phoneRaw: '555' }, { sender });
    expect(result).toEqual({ status: 'invalid_phone' });
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('returns not_configured and writes NO verification row when the sender is unconfigured', async () => {
    const sender = new FakeOtpSender({ status: 'not_configured' });
    const { db, writes } = makeFakeDb({});
    const result = await requestPhoneOtp(
      db,
      { userId: USER_ID, phoneRaw: PHONE },
      { sender, now: NOW, generateCode: () => CODE },
    );
    expect(result).toEqual({ status: 'not_configured' });
    expect(writes).toEqual([]); // honest state: nothing persisted, nothing "pending"
  });

  it('sends and persists the code HASHED and the phone ENCRYPTED, invalidating prior codes', async () => {
    const sender = new FakeOtpSender();
    const { db, writes } = makeFakeDb({ selectRows: () => [] }); // no prior send → no cooldown
    const result = await requestPhoneOtp(
      db,
      { userId: USER_ID, phoneRaw: '(519) 555-1234' },
      { sender, now: NOW, generateCode: () => CODE },
    );

    expect(result).toEqual({ status: 'sent', maskedPhone: maskPhoneE164(PHONE) });
    expect(sender.sent).toEqual([{ phoneE164: PHONE, code: CODE }]);

    const insert = writeFor(
      writes.filter((w) => w.op === 'insert'),
      schema.phoneVerifications,
    );
    expect(insert?.userId).toBe(USER_ID);
    expect(insert?.codeHash).toBe(hashOtpCode(CODE));
    expect(insert?.codeHash).not.toBe(CODE);
    // Phone is encrypted at rest — never the plaintext, and it round-trips.
    expect(insert?.phoneE164Encrypted).not.toBe(PHONE);
    // A prior-code invalidation update runs before the insert.
    expect(writes.some((w) => w.op === 'update' && w.table === schema.phoneVerifications)).toBe(true);
  });

  it('refuses a resend within the 60s cooldown', async () => {
    const sender = new FakeOtpSender();
    const recent = new Date(NOW.getTime() - 30_000); // 30s ago
    const { db, writes } = makeFakeDb({
      selectRows: (t) => (t === schema.phoneVerifications ? [{ lastSentAt: recent }] : []),
    });
    const result = await requestPhoneOtp(
      db,
      { userId: USER_ID, phoneRaw: PHONE },
      { sender, now: NOW, generateCode: () => CODE },
    );
    expect(result.status).toBe('cooldown');
    expect(sender.sent).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('verifyPhoneOtp', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  function pending(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ver-1',
      phoneE164Encrypted: encryptString(PHONE),
      codeHash: hashOtpCode(CODE),
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
      attemptCount: 0,
      ...overrides,
    };
  }

  it('increments the attempt counter and reports remaining tries on a wrong code', async () => {
    const { db, writes } = makeFakeDb({
      selectRows: (t) => (t === schema.phoneVerifications ? [pending()] : []),
    });
    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: '000000' },
      { sender: new FakeOtpSender(), now: NOW },
    );
    expect(result).toEqual({ status: 'wrong_code', attemptsRemaining: 2 });
    const upd = writeFor(
      writes.filter((w) => w.op === 'update'),
      schema.phoneVerifications,
    );
    expect(upd?.attemptCount).toBe(1);
  });

  it('locks after the third wrong attempt', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) => (t === schema.phoneVerifications ? [pending({ attemptCount: 2 })] : []),
    });
    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: '000000' },
      { sender: new FakeOtpSender(), now: NOW },
    );
    expect(result).toEqual({ status: 'locked' });
  });

  it('refuses an already-locked code even if the guess is right', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) => (t === schema.phoneVerifications ? [pending({ attemptCount: 3 })] : []),
    });
    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: CODE },
      { sender: new FakeOtpSender(), now: NOW },
    );
    expect(result).toEqual({ status: 'locked' });
  });

  it('reports expired for a code past its window', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) =>
        t === schema.phoneVerifications
          ? [pending({ expiresAt: new Date(NOW.getTime() - 1) })]
          : [],
    });
    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: CODE },
      { sender: new FakeOtpSender(), now: NOW },
    );
    expect(result).toEqual({ status: 'expired' });
  });

  it('reports no_pending when there is no active verification', async () => {
    const { db } = makeFakeDb({ selectRows: () => [] });
    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: CODE },
      { sender: new FakeOtpSender(), now: NOW },
    );
    expect(result).toEqual({ status: 'no_pending' });
  });

  it('on the right code, enrolls the channel + CASL consent + audit in ONE transaction', async () => {
    const { db, writes, transactionCalled } = makeFakeDb({
      selectRows: (t) => {
        if (t === schema.phoneVerifications) return [pending()];
        if (t === schema.parentChannels) return [{ id: 'old-channel' }]; // a prior active row
        return [];
      },
      returnRows: (t) => {
        if (t === schema.phoneVerifications) return [{ id: 'ver-1' }]; // burn wins
        if (t === schema.consentRecords) return [{ id: 'consent-1' }];
        if (t === schema.parentChannels) return [{ id: 'channel-1' }];
        return [];
      },
    });

    const result = await verifyPhoneOtp(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, code: CODE, ip: '203.0.113.5', userAgent: 'UA/1' },
      { sender: new FakeOtpSender(), now: NOW },
    );

    expect(result).toEqual({ status: 'verified', maskedPhone: maskPhoneE164(PHONE) });
    expect(transactionCalled()).toHaveBeenCalledTimes(1);

    // The prior active channel is soft-revoked (kept for audit), then a fresh row is
    // written — the write order is consent → channel → audit.
    const inserts = writes.filter((w) => w.op === 'insert');
    expect(inserts.map((w) => w.table)).toEqual([
      schema.consentRecords,
      schema.parentChannels,
      schema.auditLog,
    ]);

    const consent = writeFor(inserts, schema.consentRecords);
    expect(consent).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: SMS_CONSENT_SCOPE,
      ip: '203.0.113.5',
      userAgent: 'UA/1',
    });

    const channel = writeFor(inserts, schema.parentChannels);
    expect(channel).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      kind: 'sms',
      consentRecordId: 'consent-1',
    });
    expect(channel?.verifiedAt).toEqual(NOW);
    // The channel stores the encrypted phone, never the plaintext.
    expect(channel?.phoneE164Encrypted).not.toBe(PHONE);
    // …and the deterministic blind index the inbound webhook resolves against.
    expect(channel?.phoneE164Hash).toBe(phoneBlindIndex(PHONE));

    // Rule #6 audit — targets the channel, actor = the parent, NO raw phone.
    const audit = writeFor(inserts, schema.auditLog);
    expect(audit).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'channel_sms_enrolled',
      targetTable: 'parent_channels',
      targetId: 'channel-1',
    });
    expect(JSON.stringify(audit)).not.toContain(PHONE);

    // A prior active channel row was soft-revoked inside the same tx.
    const revoke = writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect((revoke?.payload as Record<string, unknown>)?.revokedAt).toEqual(NOW);
  });
});

describe('revokeSmsChannel', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  it('soft-revokes the active channel + records a consent withdrawal + audit in one tx', async () => {
    const { db, writes, transactionCalled } = makeFakeDb({
      selectRows: (t) => (t === schema.parentChannels ? [{ id: 'channel-1' }] : []),
    });

    const result = await revokeSmsChannel(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, ip: '203.0.113.5', userAgent: 'UA/1' },
      { now: NOW },
    );

    expect(result).toEqual({ status: 'revoked' });
    expect(transactionCalled()).toHaveBeenCalledTimes(1);

    const revoke = writes.find((w) => w.op === 'update' && w.table === schema.parentChannels);
    expect((revoke?.payload as Record<string, unknown>)?.revokedAt).toEqual(NOW);

    const consent = writeFor(
      writes.filter((w) => w.op === 'insert'),
      schema.consentRecords,
    );
    expect(consent).toMatchObject({
      userId: USER_ID,
      consentType: 'sms_service_messages',
      granted: false,
      ip: '203.0.113.5',
    });

    const audit = writeFor(
      writes.filter((w) => w.op === 'insert'),
      schema.auditLog,
    );
    expect(audit).toMatchObject({
      actor: USER_ID,
      actionTaken: 'channel_sms_revoked',
      targetTable: 'parent_channels',
    });
  });

  it('reports not_found when there is no active channel', async () => {
    const { db, writes } = makeFakeDb({ selectRows: () => [] });
    const result = await revokeSmsChannel(
      db,
      { userId: USER_ID, familyId: FAMILY_ID },
      { now: NOW },
    );
    expect(result).toEqual({ status: 'not_found' });
    expect(writes).toEqual([]);
  });
});

describe('resolveVerifiedChannelByPhone (A3 inbound lookup)', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  it('resolves an inbound number to its active, verified channel owner', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) =>
        t === schema.parentChannels
          ? [{ userId: USER_ID, familyId: FAMILY_ID, id: 'channel-1', verifiedAt: NOW, revokedAt: null }]
          : [],
    });

    // A differently-FORMATTED but equal number still resolves (shared canonical
    // normalizer feeds the blind index on both enrol and inbound).
    const result = await resolveVerifiedChannelByPhone(db, '(519) 555-1234');
    expect(result).toEqual({ userId: USER_ID, familyId: FAMILY_ID, channelId: 'channel-1' });
  });

  it('does NOT resolve a REVOKED channel (revoked number no longer routes)', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) =>
        t === schema.parentChannels
          ? [{ userId: USER_ID, familyId: FAMILY_ID, id: 'channel-1', verifiedAt: NOW, revokedAt: NOW }]
          : [],
    });
    expect(await resolveVerifiedChannelByPhone(db, PHONE)).toBeNull();
  });

  it('does NOT resolve an unverified (pending) channel', async () => {
    const { db } = makeFakeDb({
      selectRows: (t) =>
        t === schema.parentChannels
          ? [{ userId: USER_ID, familyId: FAMILY_ID, id: 'channel-1', verifiedAt: null, revokedAt: null }]
          : [],
    });
    expect(await resolveVerifiedChannelByPhone(db, PHONE)).toBeNull();
  });

  it('returns null when no channel matches the number', async () => {
    const { db } = makeFakeDb({ selectRows: () => [] });
    expect(await resolveVerifiedChannelByPhone(db, PHONE)).toBeNull();
  });

  it('returns null for a malformed inbound number (never hits the DB path with junk)', async () => {
    const { db } = makeFakeDb({ selectRows: () => [] });
    expect(await resolveVerifiedChannelByPhone(db, 'not-a-number')).toBeNull();
  });
});

import { schema } from '@hale/db';
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintChannelSigninTokens } from '~/lib/auth/channel-signin';
import { requestClaimCode, verifyClaimCode } from '~/lib/auth/claim-by-phone';
import { requestConnectLinkCode, verifyConnectLinkCode } from '~/lib/auth/connect-link-code';
import {
  requestPromoJoinCode,
  smsExternalAuthId,
  verifyPromoJoinCode,
} from '~/lib/billing/new-visitor-join';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { setRateLimiterForTesting } from '~/lib/rate-limit/apply';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from './otp';
import { FakeOtpSender } from './otp-sender';
import { requestPhoneOtp, verifyPhoneOtp } from './sms-consent-core';

/**
 * Every check of a phone_verifications code spends one of its three tries, including
 * guesses sent at the same moment. These drive the real request and verify functions of
 * each door against the real DDL: a fake database answers every read with the same row,
 * so it cannot show two checks reading one count.
 */

const h = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('~/lib/db', () => ({ db: () => h.database }));

const FLAG = 'SIGNIN_CODE_ATOMIC_ATTEMPTS_ENABLED';
const KEY = Buffer.alloc(32, 9).toString('base64');
const START = new Date('2026-11-24T15:00:00.000Z');
const SIMULTANEOUS_GUESSES = 5;

type Outcome = 'ok' | string;

interface DoorRun {
  userId: string;
  send(): Promise<void>;
  guess(code: string): Promise<Outcome>;
}

let db: TestDb;
let sender: FakeOtpSender;
let seq = 0;

function nextPhone(): string {
  seq += 1;
  return `+1416555${String(100 + seq).padStart(4, '0')}`;
}

function lastCode(): string {
  const code = sender.sent.at(-1)?.code;
  if (!code) throw new Error('no code was sent');
  return code;
}

function wrongFor(code: string): string {
  const last = Number(code.at(-1));
  return `${code.slice(0, -1)}${(last + 1) % 10}`;
}

async function newestCode(userId: string) {
  const [row] = await db.database
    .select({
      attemptCount: schema.phoneVerifications.attemptCount,
      consumedAt: schema.phoneVerifications.consumedAt,
    })
    .from(schema.phoneVerifications)
    .where(eq(schema.phoneVerifications.userId, userId))
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);
  if (!row) throw new Error('no code row');
  return row;
}

async function seedTextParent(): Promise<{ userId: string; familyId: string; phone: string }> {
  const phone = nextPhone();
  const seeded = await seedFamily(db.database);
  await db.database
    .update(schema.users)
    .set({ externalAuthId: `sms:${phoneBlindIndex(phone)}` })
    .where(eq(schema.users.id, seeded.parentUserId));
  await db.database.insert(schema.parentChannels).values({
    familyId: seeded.familyId,
    userId: seeded.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: START,
  });
  return { userId: seeded.parentUserId, familyId: seeded.familyId, phone };
}

async function signInDoor(): Promise<DoorRun> {
  const parent = await seedTextParent();
  return {
    userId: parent.userId,
    async send() {
      expect(
        await requestClaimCode(
          db.database,
          { phoneRaw: parent.phone, now: new Date() },
          { sender },
        ),
      ).toEqual({ status: 'sent' });
    },
    async guess(code) {
      const out = await verifyClaimCode(db.database, {
        phoneRaw: parent.phone,
        code,
        now: new Date(),
      });
      return out.status === 'claimed' ? 'ok' : out.reason;
    },
  };
}

async function joinDoor(): Promise<DoorRun> {
  const phone = nextPhone();
  const send = async () => {
    expect(
      await requestPromoJoinCode(db.database, { phoneRaw: phone, now: new Date() }, { sender }),
    ).toEqual({ status: 'sent' });
  };
  await send();
  const [user] = await db.database
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, smsExternalAuthId(phoneBlindIndex(phone))));
  if (!user) throw new Error('join request made no user');
  // The visitor exists now; drop the setup code so each test sends, and reads, its own.
  await db.database
    .delete(schema.phoneVerifications)
    .where(eq(schema.phoneVerifications.userId, user.id));
  return {
    userId: user.id,
    send,
    async guess(code) {
      const out = await verifyPromoJoinCode(db.database, {
        phoneRaw: phone,
        code,
        now: new Date(),
      });
      return out.status === 'ok' ? 'ok' : out.reason;
    },
  };
}

async function settingsDoor(): Promise<DoorRun> {
  const phone = nextPhone();
  const seeded = await seedFamily(db.database);
  return {
    userId: seeded.parentUserId,
    async send() {
      const sent = await requestPhoneOtp(
        db.database,
        { userId: seeded.parentUserId, phoneRaw: phone },
        { sender, now: new Date() },
      );
      expect(sent.status).toBe('sent');
    },
    async guess(code) {
      const out = await verifyPhoneOtp(
        db.database,
        { userId: seeded.parentUserId, familyId: seeded.familyId, code },
        { sender, now: new Date() },
      );
      return out.status === 'verified' ? 'ok' : out.status;
    },
  };
}

async function linkDoorFor(userId: string): Promise<DoorRun> {
  const [link] = await mintChannelSigninTokens(db.database, { userId, count: 1, now: new Date() });
  if (!link) throw new Error('expected a link');
  return {
    userId,
    async send() {
      expect(
        await requestConnectLinkCode(
          db.database,
          { token: link.token, now: new Date() },
          { sender },
        ),
      ).toBe('sent');
    },
    async guess(code) {
      const out = await verifyConnectLinkCode(db.database, {
        token: link.token,
        code,
        now: new Date(),
      });
      return out.ok ? 'ok' : out.reason;
    },
  };
}

async function linkDoor(): Promise<DoorRun> {
  return linkDoorFor((await seedTextParent()).userId);
}

const DOORS: Array<[string, () => Promise<DoorRun>]> = [
  ['/sign-in', signInDoor],
  ['the new-visitor join', joinDoor],
  ['the Settings number check', settingsDoor],
  ['a texted connect link', linkDoor],
];

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  db = await createTestDb();
  h.database = db.database;
  setRateLimiterForTesting(undefined);
});

afterAll(async () => {
  setRateLimiterForTesting(undefined);
  await db.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  sender = new FakeOtpSender();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(DOORS)('guesses sent at the same moment, on %s', (_name, open) => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('each spend a try, so the cap holds and then even the right code is locked', async () => {
    const door = await open();
    await door.send();
    const code = lastCode();

    const outcomes = await Promise.all(
      Array.from({ length: SIMULTANEOUS_GUESSES }, () => door.guess(wrongFor(code))),
    );

    expect(outcomes).not.toContain('ok');
    expect(outcomes.filter((outcome) => outcome !== 'locked').length).toBeLessThanOrEqual(
      OTP_MAX_ATTEMPTS,
    );
    expect(await newestCode(door.userId)).toEqual({
      attemptCount: OTP_MAX_ATTEMPTS,
      consumedAt: null,
    });
    expect(await door.guess(code)).toBe('locked');
  });
});

describe.each([
  ['on', 'true'],
  ['off', undefined],
])('one guess at a time, flag %s', (_label, value) => {
  beforeEach(() => {
    if (value) vi.stubEnv(FLAG, value);
  });

  describe.each(DOORS)('on %s', (_name, open) => {
    it('counts a wrong guess once and still takes the right code', async () => {
      const door = await open();
      await door.send();
      const code = lastCode();

      expect(await door.guess(wrongFor(code))).toBe('wrong_code');
      expect((await newestCode(door.userId)).attemptCount).toBe(1);
      expect(await door.guess(code)).toBe('ok');
      expect((await newestCode(door.userId)).consumedAt).not.toBeNull();
    });

    it('takes the right code on the last of the three tries', async () => {
      const door = await open();
      await door.send();
      const code = lastCode();

      expect(await door.guess(wrongFor(code))).toBe('wrong_code');
      expect(await door.guess(wrongFor(code))).toBe('wrong_code');
      expect(await door.guess(code)).toBe('ok');
    });

    it('refuses an expired code', async () => {
      const door = await open();
      await door.send();
      const code = lastCode();

      vi.setSystemTime(new Date(Date.now() + OTP_TTL_MS + 1_000));

      expect(await door.guess(code)).toBe('expired');
    });
  });
});

describe('a guess on one door leaves a code sent for another alone', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('a /sign-in guess neither spends nor consumes a pending connect-link code', async () => {
    const parent = await seedTextParent();
    const link = await linkDoorFor(parent.userId);
    await link.send();
    const code = lastCode();

    for (const guess of [wrongFor(code), code]) {
      expect(
        await verifyClaimCode(db.database, {
          phoneRaw: parent.phone,
          code: guess,
          now: new Date(),
        }),
      ).toEqual({ status: 'refused', reason: 'no_pending_code' });
    }
    expect(await newestCode(parent.userId)).toEqual({ attemptCount: 0, consumedAt: null });

    // Positive control: the same read sees a try spent on the code's own door.
    expect(await link.guess(wrongFor(code))).toBe('wrong_code');
    expect((await newestCode(parent.userId)).attemptCount).toBe(1);
    expect(await link.guess(code)).toBe('ok');
  });

  it('a connect-link guess neither spends nor consumes a pending /sign-in code', async () => {
    const parent = await seedTextParent();
    const link = await linkDoorFor(parent.userId);
    expect(
      await requestClaimCode(db.database, { phoneRaw: parent.phone, now: new Date() }, { sender }),
    ).toEqual({ status: 'sent' });
    const code = lastCode();

    for (const guess of [wrongFor(code), code]) {
      expect(await link.guess(guess)).toBe('no_pending_code');
    }
    expect(await newestCode(parent.userId)).toEqual({ attemptCount: 0, consumedAt: null });

    // Positive control, as above.
    const wrong = await verifyClaimCode(db.database, {
      phoneRaw: parent.phone,
      code: wrongFor(code),
      now: new Date(),
    });
    expect(wrong).toEqual({ status: 'refused', reason: 'wrong_code' });
    expect((await newestCode(parent.userId)).attemptCount).toBe(1);
    const right = await verifyClaimCode(db.database, {
      phoneRaw: parent.phone,
      code,
      now: new Date(),
    });
    expect(right.status).toBe('claimed');
  });
});

describe('turning the flag back off', () => {
  it('keeps a connect-link code sent while it was on usable', async () => {
    vi.stubEnv(FLAG, 'true');
    const link = await linkDoor();
    await link.send();
    const code = lastCode();

    vi.stubEnv(FLAG, '');

    expect(await link.guess(wrongFor(code))).toBe('wrong_code');
    expect(await link.guess(code)).toBe('ok');
  });
});

import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { COLD_START_ASK, SITTING_SESSION_REMINDER, greeting } from './copy';
import { type FakeDb, makeFakeDb } from './fakes';
import {
  type FirstReplyRecoveryDeps,
  defaultFirstReplyRecoveryDeps,
  firstReplyRecoveryEligible,
  runFirstReplyRecoveryCron,
} from './first-reply-recovery';
import { FOUNDER_PAIR_SESSION_IDS } from './sitting-reminder';
import { FakeTransport } from './transport';

/**
 * VIL-332 — same-day first-hello for an inbound that minted a session + SID
 * and then left no outbound. Not the 8am Still here line.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const OTHER = '+14165555678';
const INBOUND_SID = 'SM11111111111111111111111111111111';
/** Friday 28 Aug 2026, 12:28 p.m. America/Toronto (EDT, UTC-4). */
const SAME_DAY_NOON_ET = new Date('2026-08-28T16:28:00.000Z');

function dataBlob(
  transcript: Array<{
    direction: 'in' | 'out';
    body: string;
    providerId: string | null;
    at: string;
  }> = [],
): string {
  return encryptString(
    JSON.stringify({ collected: { children: [], postalCode: null }, transcript }),
  );
}

function seedSession(
  fake: FakeDb,
  over: {
    id?: string;
    phoneE164?: string;
    state?: string;
    createdAt?: Date;
    lastProviderId?: string | null;
    firstReplyRecoveredAt?: Date | null;
    closedAt?: Date | null;
    familyId?: string | null;
    sourceCode?: string | null;
    transcript?: Array<{
      direction: 'in' | 'out';
      body: string;
      providerId: string | null;
      at: string;
    }>;
  } = {},
): string {
  const phoneE164 = over.phoneE164 ?? PHONE;
  const values = {
    ...(over.id ? { id: over.id } : {}),
    phoneHash: phoneBlindIndex(phoneE164),
    phoneEncrypted: encryptString(phoneE164),
    state: over.state ?? 'awaiting_details',
    sourceCode: over.sourceCode === undefined ? null : over.sourceCode,
    dataEncrypted: dataBlob(over.transcript ?? []),
    createdAt: over.createdAt ?? SAME_DAY_NOON_ET,
    lastProviderId: over.lastProviderId === undefined ? INBOUND_SID : over.lastProviderId,
    firstReplyRecoveredAt:
      over.firstReplyRecoveredAt === undefined ? null : over.firstReplyRecoveredAt,
    closedAt: over.closedAt === undefined ? null : over.closedAt,
    familyId: over.familyId === undefined ? null : over.familyId,
  };
  fake.db.insert(schema.smsIntakeSessions).values(values);
  const row = fake.rows(schema.smsIntakeSessions).at(-1);
  if (!row || typeof row.id !== 'string') throw new Error('seedSession: insert returned no id');
  return row.id;
}

function deps(transport: FakeTransport): FirstReplyRecoveryDeps {
  return { transport };
}

describe('firstReplyRecoveryEligible', () => {
  const open = {
    state: 'awaiting_details' as const,
    closedAt: null,
    firstReplyRecoveredAt: null,
    familyId: null,
    lastProviderId: INBOUND_SID,
    hasOutbound: false,
  };

  it('accepts awaiting_details + SID + no outbound', () => {
    expect(firstReplyRecoveryEligible(open)).toBe(true);
  });

  it('refuses a session that already has outbound', () => {
    expect(firstReplyRecoveryEligible({ ...open, hasOutbound: true })).toBe(false);
  });

  it('refuses a session with no inbound SID', () => {
    expect(firstReplyRecoveryEligible({ ...open, lastProviderId: null })).toBe(false);
  });

  it('refuses a completed or stopped session', () => {
    expect(firstReplyRecoveryEligible({ ...open, state: 'complete', familyId: 'fam-1' })).toBe(
      false,
    );
    expect(
      firstReplyRecoveryEligible({ ...open, state: 'stopped', closedAt: SAME_DAY_NOON_ET }),
    ).toBe(false);
  });
});

describe('runFirstReplyRecoveryCron', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  it('sends the locked first-hello once for a session with SID and no outbound', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    const first = await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);
    expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(transport.bodies()[0]).toContain(COLD_START_ASK);
    expect(transport.bodies()).not.toContain(SITTING_SESSION_REMINDER);
    expect(transport.sent[0]?.to).toBe(PHONE);
  });

  it('skips a session that already has outbound', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      transcript: [
        {
          direction: 'in',
          body: 'hi',
          providerId: INBOUND_SID,
          at: SAME_DAY_NOON_ET.toISOString(),
        },
        {
          direction: 'out',
          body: greeting(null, 'en'),
          providerId: 'SMout',
          at: SAME_DAY_NOON_ET.toISOString(),
        },
      ],
    });

    const result = await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('does not send the first-hello to the founder-pair session ids', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const [firstId, secondId] = [...FOUNDER_PAIR_SESSION_IDS];
    expect(FOUNDER_PAIR_SESSION_IDS.size).toBe(2);
    seedSession(fake, { id: firstId });
    seedSession(fake, { id: secondId, phoneE164: OTHER });

    const result = await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).map((row) => row.firstReplyRecoveredAt)).toEqual([
      SAME_DAY_NOON_ET,
      SAME_DAY_NOON_ET,
    ]);
  });

  it('caps at one send — a second tick is quiet', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);
    const second = await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);

    expect(second).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual([greeting(null, 'en')]);
  });

  it('uses the venue greeting when the session already has a venue', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { sourceCode: 'LIBRARY' });

    await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);
    expect(transport.bodies()).toEqual([greeting('library', 'en')]);
    expect(transport.bodies()).not.toContain(SITTING_SESSION_REMINDER);
  });

  it('does not mint a family — the session stays an intake', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    await runFirstReplyRecoveryCron(fake.db, deps(transport), SAME_DAY_NOON_ET);

    expect(fake.rows(schema.families)).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      familyId: null,
      state: 'awaiting_details',
    });
  });

  it('wires the real Twilio outbound leg into the default deps', async () => {
    const { transport } = defaultFirstReplyRecoveryDeps();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    await expect(transport.send({ to: PHONE, body: greeting(null, 'en') })).rejects.toThrow(
      /twilio not configured/,
    );
  });
});

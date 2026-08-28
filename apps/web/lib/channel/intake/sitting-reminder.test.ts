import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { SITTING_SESSION_REMINDER } from './copy';
import { type FakeDb, makeFakeDb } from './fakes';
import {
  SITTING_REMINDER_HOUR_LOCAL,
  SITTING_REMINDER_TIMEZONE,
  type SittingReminderDeps,
  defaultSittingReminderDeps,
  isNextTorontoMorning,
  isSittingReminderSlot,
  runSittingReminderCron,
  sittingSessionEligible,
} from './sitting-reminder';
import { FakeTransport } from './transport';

/**
 * VIL-324 — one next-morning reminder for a sitting first-hello, then quiet.
 *
 * The clock is Designer-locked: 8:00 America/Toronto the morning AFTER the session
 * opened. Not 9:00. Not a 24-hour offset. Not a family-local hour — these rows are
 * still intakes, and they have no family timezone to consult.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const OTHER = '+14165555678';

/** Wednesday 27 Aug 2026, 8:00 a.m. America/Toronto (EDT, UTC-4). */
const TORONTO_8AM = new Date('2026-08-27T12:00:00.000Z');
/** Same morning, 9:00 a.m. Toronto — the hour this reminder must never invent. */
const TORONTO_9AM = new Date('2026-08-27T13:00:00.000Z');
/** Same morning, 7:00 a.m. Toronto — too early. */
const TORONTO_7AM = new Date('2026-08-27T11:00:00.000Z');
/** Tuesday 26 Aug 2026, 7:00 p.m. Toronto — the first-hello the night before. */
const FIRST_HELLO_PREVIOUS_EVENING = new Date('2026-08-26T23:00:00.000Z');
/** Wednesday 27 Aug 2026, 7:00 a.m. Toronto — same calendar morning as the 8:00 slot. */
const FIRST_HELLO_SAME_MORNING = new Date('2026-08-27T11:00:00.000Z');

function dataBlob(): string {
  return encryptString(
    JSON.stringify({ collected: { children: [], postalCode: null }, transcript: [] }),
  );
}

function seedSession(
  fake: FakeDb,
  over: {
    phoneE164?: string;
    state?: string;
    createdAt?: Date;
    sittingReminderSentAt?: Date | null;
    closedAt?: Date | null;
    familyId?: string | null;
    followUpCount?: number;
  } = {},
): string {
  const phoneE164 = over.phoneE164 ?? PHONE;
  const values = {
    phoneHash: phoneBlindIndex(phoneE164),
    phoneEncrypted: encryptString(phoneE164),
    state: over.state ?? 'awaiting_details',
    dataEncrypted: dataBlob(),
    createdAt: over.createdAt ?? FIRST_HELLO_PREVIOUS_EVENING,
    sittingReminderSentAt:
      over.sittingReminderSentAt === undefined ? null : over.sittingReminderSentAt,
    closedAt: over.closedAt === undefined ? null : over.closedAt,
    familyId: over.familyId === undefined ? null : over.familyId,
    followUpCount: over.followUpCount ?? 0,
  };
  fake.db.insert(schema.smsIntakeSessions).values(values);
  const row = fake.rows(schema.smsIntakeSessions).at(-1);
  if (!row || typeof row.id !== 'string') throw new Error('seedSession: insert returned no id');
  return row.id;
}

function deps(transport: FakeTransport): SittingReminderDeps {
  return { transport };
}

describe('SITTING_SESSION_REMINDER — Designer lock', () => {
  it('is the verbatim locked line, GSM-7 hyphens, no invented date or city clock', () => {
    expect(SITTING_SESSION_REMINDER).toBe(
      "Still here if you want me watching. Reply with your kids' names, ages, and postal code and I'll send what's coming.",
    );
    expect(SITTING_SESSION_REMINDER).not.toMatch(/[\u2013\u2014]/);
    expect(SITTING_SESSION_REMINDER).not.toMatch(/\d{1,2}:\d{2}/);
    expect(SITTING_SESSION_REMINDER).not.toMatch(/Toronto|August|tomorrow|Monday|Tuesday/i);
    expect(smsEncoding(SITTING_SESSION_REMINDER)).toBe('gsm7');
  });

  it('is locked to 8:00 America/Toronto — not 9:00, not another hour', () => {
    expect(SITTING_REMINDER_TIMEZONE).toBe('America/Toronto');
    expect(SITTING_REMINDER_HOUR_LOCAL).toBe(8);
    expect(SITTING_REMINDER_HOUR_LOCAL).not.toBe(9);
  });
});

describe('isSittingReminderSlot', () => {
  it('is true for the 8:00 Toronto hour and false for 7:00 and 9:00', () => {
    expect(isSittingReminderSlot(TORONTO_8AM)).toBe(true);
    expect(isSittingReminderSlot(new Date('2026-08-27T12:59:00.000Z'))).toBe(true);
    expect(isSittingReminderSlot(TORONTO_7AM)).toBe(false);
    expect(isSittingReminderSlot(TORONTO_9AM)).toBe(false);
  });
});

describe('isNextTorontoMorning', () => {
  it('is true the Toronto calendar morning after first-hello, false the same morning', () => {
    expect(isNextTorontoMorning(FIRST_HELLO_PREVIOUS_EVENING, TORONTO_8AM)).toBe(true);
    expect(isNextTorontoMorning(FIRST_HELLO_SAME_MORNING, TORONTO_8AM)).toBe(false);
    expect(isNextTorontoMorning(TORONTO_8AM, TORONTO_8AM)).toBe(false);
  });
});

describe('sittingSessionEligible', () => {
  const open = {
    state: 'awaiting_details' as const,
    closedAt: null,
    sittingReminderSentAt: null,
    familyId: null,
    createdAt: FIRST_HELLO_PREVIOUS_EVENING,
  };

  it('accepts an open awaiting_details session the next Toronto morning at 8:00', () => {
    expect(sittingSessionEligible(open, TORONTO_8AM)).toBe(true);
  });

  it('refuses 9:00 Toronto — that hour is not the lock', () => {
    expect(sittingSessionEligible(open, TORONTO_9AM)).toBe(false);
  });

  it('refuses the same Toronto morning, even at 8:00', () => {
    expect(
      sittingSessionEligible({ ...open, createdAt: FIRST_HELLO_SAME_MORNING }, TORONTO_8AM),
    ).toBe(false);
  });

  it('refuses a completed session', () => {
    expect(
      sittingSessionEligible(
        { ...open, state: 'complete', closedAt: TORONTO_8AM, familyId: 'fam-1' },
        TORONTO_8AM,
      ),
    ).toBe(false);
  });

  it('refuses STOP', () => {
    expect(
      sittingSessionEligible({ ...open, state: 'stopped', closedAt: TORONTO_8AM }, TORONTO_8AM),
    ).toBe(false);
  });

  it('refuses a session already reminded', () => {
    expect(
      sittingSessionEligible(
        { ...open, sittingReminderSentAt: FIRST_HELLO_PREVIOUS_EVENING },
        TORONTO_8AM,
      ),
    ).toBe(false);
  });

  it('refuses a provisioned family — sitting sessions stay intakes', () => {
    expect(sittingSessionEligible({ ...open, familyId: 'fam-1' }, TORONTO_8AM)).toBe(false);
  });
});

describe('runSittingReminderCron', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
  });

  it('sends the locked line once from the injected Twilio transport', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    const first = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual([SITTING_SESSION_REMINDER]);
    expect(transport.sent[0]?.to).toBe(PHONE);
  });

  it('caps at one send — a second tick in the same hour is quiet', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    const second = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);

    expect(second).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual([SITTING_SESSION_REMINDER]);
    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      sittingReminderSentAt: TORONTO_8AM,
      followUpCount: 0,
      state: 'awaiting_details',
      familyId: null,
    });
  });

  it('skips a completed session', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      state: 'complete',
      closedAt: FIRST_HELLO_PREVIOUS_EVENING,
      familyId: 'fam-1',
    });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('skips STOP', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { state: 'stopped', closedAt: FIRST_HELLO_PREVIOUS_EVENING });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('skips a session already reminded', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { sittingReminderSentAt: FIRST_HELLO_PREVIOUS_EVENING });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('does not send at 9:00 Toronto', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_9AM);
    expect(result).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual([]);
  });

  it('does not mint a family — the session stays an intake', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { phoneE164: OTHER });

    await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);

    expect(fake.rows(schema.families)).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      familyId: null,
      state: 'awaiting_details',
    });
  });

  it('wires the real Twilio outbound leg into the default deps', async () => {
    const { transport } = defaultSittingReminderDeps();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    await expect(transport.send({ to: PHONE, body: SITTING_SESSION_REMINDER })).rejects.toThrow(
      /twilio not configured/,
    );
  });
});

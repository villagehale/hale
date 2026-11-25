import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { threadIfParent } from '~/lib/channel/thread';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  failurePageCrisisPager,
  noteCrisisReplySent,
  pageFailureAlerts,
} from '~/lib/monitoring/failure-page';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from './fakes';
import { type IntakeDeps, handleInboundSms, handleStop } from './machine';
import {
  MESSAGE_HOLD,
  STOP_PENDING_HOLD,
  clearCollisionHold,
  holdSender,
  isSenderHeld,
  markStopPending,
  recordStopRan,
} from './opt-out-hold';
import type { OptOutReader, OptOutReading } from './opt-out-reader';
import { type OptOutRecoveryDeps, recoverHeldOptOutReads } from './opt-out-recovery';
import { OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV } from './opt-out-turn-flags';
import { createSession, loadOpenSession } from './session';
import { FakeTransport } from './transport';

/**
 * A text whose read failed holds its number until it is read again. When the re-read says
 * stop, the hold has to outlive every write of the stop. Against the real DDL and the real
 * isSenderHeld; the reader is a fake at its port (rule #8), since what the model makes of
 * a text is the eval harness's job.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+15555550191';
const HASH = () => phoneBlindIndex(PHONE);
const HELD_ID = 'pm-held-stop';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const SENT_AT = new Date(NOW.getTime() - 20 * 60_000);
const CONFIRMATION = 'Done, you will not hear from me again.';
const STOP: OptOutReading = { intent: 'stop', confirmation: CONFIRMATION, language: 'en' };
const NONE: OptOutReading = { intent: 'none', confirmation: '', language: 'en' };

const allowed = (): RateLimiter => new FakeRateLimiter(() => NOW.getTime());
const overLimit = (): RateLimiter => ({
  check: async () => ({ allowed: false, retryAfterSec: 60, firstDenied: false }),
});

class AckTimesOut extends FakeTransport {
  override async send(): Promise<{ providerMessageId: string }> {
    throw new LinqSendError('timeout', 0, false);
  }
}

/** The read cache is keyed on the words for a minute, so every case texts its own. */
let texts = 0;
function ownText(): string {
  texts += 1;
  return `please leave us alone now, note ${texts}`;
}

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec(
    'truncate table opt_out_held_messages, opt_out_read_holds, channel_messages, parent_channels, consent_records, audit_log, sms_intake_sessions, caregiver_invites, secret_santa_participants, secret_santa_draws, linq_shared_group_people, party_rsvps, party_invites, rate_limits, family_members, families, users cascade',
  );
});

/** A parent whose text was stored and then held because its read failed. */
async function heldParent(text: string): Promise<{ familyId: string; parentUserId: string }> {
  const family = await seedFamily(db.database, 'Stop Hold Family');
  await db.database.insert(schema.parentChannels).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: HASH(),
    verifiedAt: new Date(NOW.getTime() - 7 * 24 * 3_600_000),
  });
  await db.database.insert(schema.channelMessages).values({
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    channel: 'sms',
    direction: 'in',
    category: 'reply',
    providerMessageId: HELD_ID,
    status: 'delivered',
    body: text,
    sentAt: SENT_AT,
  });
  await holdSender(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID, now: SENT_AT });
  expect(await isSenderHeld(db.database, HASH())).toBe(true);
  return family;
}

/** Someone mid-intake, with no family yet, whose text is held. */
async function heldIntake(): Promise<void> {
  await createSession(db.database, {
    phoneE164: PHONE,
    state: 'awaiting_details',
    sourceCode: null,
  });
  await holdSender(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID, now: SENT_AT });
  expect((await loadOpenSession(db.database, PHONE))?.state).toBe('awaiting_details');
  expect(await isSenderHeld(db.database, HASH())).toBe(true);
}

function intakeDeps(
  reading: OptOutReading,
  transport: FakeTransport,
  limiter: RateLimiter,
  over: Partial<IntakeDeps> = {},
): IntakeDeps {
  return {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter,
    optOutReader: { read: async () => reading },
    now: NOW,
    ...over,
  };
}

function delivery(transport: FakeTransport, text: string) {
  return transport.inbound(PHONE, text, { providerId: HELD_ID, receivedAt: SENT_AT });
}

const REFUSED = 'refused for the test';

/** A real database fault on one table's writes, not a mock of the code that writes it. */
async function withRefused<T>(
  operation: 'update' | 'delete',
  table: RefusableTable,
  run: () => Promise<T>,
): Promise<T> {
  await refuseWrites(operation, table);
  try {
    return await run();
  } finally {
    await allowWrites(table);
  }
}

type RefusableTable = 'parent_channels' | 'sms_intake_sessions' | 'opt_out_held_messages';

function refuseWrites(operation: 'update' | 'delete', table: RefusableTable) {
  return db.exec(`
    create function refuse_write() returns trigger language plpgsql
      as $$ begin raise exception '${REFUSED}'; end $$;
    create trigger refuse_write before ${operation} on ${table}
      for each row execute function refuse_write();
  `);
}

function allowWrites(table: RefusableTable) {
  return db.exec(`drop trigger refuse_write on ${table}; drop function refuse_write();`);
}

const withRevokeRefused = <T>(run: () => Promise<T>): Promise<T> =>
  withRefused('update', 'parent_channels', run);

const unusedWriter: SaidLineWriter = {
  write: async () => {
    throw new Error('a stop is never written by the crisis writer');
  },
};

function sweepDeps(reader: OptOutReader, transport: FakeTransport, now: Date): OptOutRecoveryDeps {
  return {
    reader,
    transport,
    saidLine: unusedWriter,
    threadMessage: threadIfParent,
    crisisPager: failurePageCrisisPager(db.database, { now, post: async () => 'sent' }),
    preflight: async () => ({ proceed: true, health: null }),
    now,
  };
}

async function channelRevoked(parentUserId: string): Promise<boolean> {
  const [row] = await db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, parentUserId));
  return row?.revokedAt != null;
}

async function withdrawals(parentUserId: string): Promise<number> {
  const rows = await db.database
    .select({ granted: schema.consentRecords.granted })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.userId, parentUserId));
  return rows.filter((row) => row.granted === false).length;
}

describe.each([
  ['the normal path', allowed],
  ['the rate-limited path', overLimit],
])('a stop read on %s', (_path, limiter) => {
  it('flag on: a stop that fails to record stays held; a retry records it and releases', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    const failing = new FakeTransport();

    await expect(
      withRevokeRefused(() =>
        handleInboundSms(
          db.database,
          delivery(failing, text),
          intakeDeps(STOP, failing, limiter()),
        ),
      ),
    ).rejects.toThrow(REFUSED);

    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
    expect(failing.sent).toEqual([]);

    const retry = new FakeTransport();
    const outcome = await handleInboundSms(
      db.database,
      delivery(retry, text),
      intakeDeps(STOP, retry, limiter()),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(retry.bodies()).toEqual([CONFIRMATION]);
  }, 30_000);

  it('flag off: the same failure releases the sender, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    const text = ownText();
    const family = await heldParent(text);
    const failing = new FakeTransport();

    await expect(
      withRevokeRefused(() =>
        handleInboundSms(
          db.database,
          delivery(failing, text),
          intakeDeps(STOP, failing, limiter()),
        ),
      ),
    ).rejects.toThrow(REFUSED);

    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('flag on: a retry after the revocation committed and only the ack failed releases', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    const timingOut = new AckTimesOut();

    await expect(
      handleInboundSms(
        db.database,
        delivery(timingOut, text),
        intakeDeps(STOP, timingOut, limiter()),
      ),
    ).rejects.toBeInstanceOf(LinqSendError);

    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const retry = new FakeTransport();
    const outcome = await handleInboundSms(
      db.database,
      delivery(retry, text),
      intakeDeps(STOP, retry, limiter()),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(retry.bodies()).toEqual([CONFIRMATION]);
  }, 30_000);

  it('flag on: a mid-intake stop whose ack failed is no duplicate on the retry', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    await heldIntake();
    const timingOut = new AckTimesOut();

    await expect(
      handleInboundSms(
        db.database,
        delivery(timingOut, text),
        intakeDeps(STOP, timingOut, limiter()),
      ),
    ).rejects.toBeInstanceOf(LinqSendError);

    expect(await loadOpenSession(db.database, PHONE)).toBeNull();
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const retry = new FakeTransport();
    const outcome = await handleInboundSms(
      db.database,
      delivery(retry, text),
      intakeDeps(STOP, retry, limiter()),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(retry.bodies()).toEqual([CONFIRMATION]);
  }, 30_000);
});

describe('the hold a failed stop leaves', () => {
  it('is what the opt-out hold sweep pages #ops about', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    await heldParent(text);
    const failing = new FakeTransport();
    await expect(
      withRevokeRefused(() =>
        handleInboundSms(
          db.database,
          delivery(failing, text),
          intakeDeps(STOP, failing, allowed()),
        ),
      ),
    ).rejects.toThrow(REFUSED);

    const posted: string[] = [];
    const swept = await pageFailureAlerts(db.database, {
      now: NOW,
      post: async (line) => {
        posted.push(line);
        return 'sent';
      },
    });

    expect(swept.optOutHolds.posted).toBe(1);
    expect(posted).toEqual([
      'Hale: opt-out reads held. messages 1. numbers 1. not in ledger 0. legacy 0. oldest 0h.',
    ]);
  }, 30_000);

  it('is released by the recovery sweep when no redelivery comes, and nothing is sent', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    const timingOut = new AckTimesOut();
    await expect(
      handleInboundSms(
        db.database,
        delivery(timingOut, text),
        intakeDeps(STOP, timingOut, allowed()),
      ),
    ).rejects.toBeInstanceOf(LinqSendError);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const sweepTransport = new FakeTransport();
    const result = await recoverHeldOptOutReads(
      db.database,
      sweepDeps({ read: async () => STOP }, sweepTransport, NOW),
    );

    expect(result.outcomes.already_stopped).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(sweepTransport.sent).toEqual([]);
  }, 30_000);

  it('survives a release that fails once the stop is recorded, without failing the turn', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = ownText();
    const family = await heldParent(text);
    const transport = new FakeTransport();

    const outcome = await withRefused('delete', 'opt_out_held_messages', () =>
      handleInboundSms(
        db.database,
        delivery(transport, text),
        intakeDeps(STOP, transport, allowed()),
      ),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(transport.bodies()).toEqual([CONFIRMATION]);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
  }, 30_000);
});

describe('a reading that is not a stop', () => {
  it('flag on: releases at once, before the rest of the turn can fail', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    await heldParent(text);
    await createSession(db.database, {
      phoneE164: PHONE,
      state: 'awaiting_details',
      sourceCode: null,
    });
    const transport = new FakeTransport();

    await expect(
      withRefused('update', 'sms_intake_sessions', () =>
        handleInboundSms(
          db.database,
          delivery(transport, text),
          intakeDeps(NONE, transport, allowed()),
        ),
      ),
    ).rejects.toThrow(REFUSED);

    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);
});

describe('a stop read live that could not be recorded', () => {
  const LATER = new Date(NOW.getTime() + 16 * 60_000);

  async function failedLiveStop(text: string): Promise<void> {
    const failing = new FakeTransport();
    await expect(
      withRevokeRefused(() =>
        handleInboundSms(
          db.database,
          delivery(failing, text),
          intakeDeps(STOP, failing, allowed()),
        ),
      ),
    ).rejects.toThrow(REFUSED);
  }

  function readerOf(reading: OptOutReading): { reader: OptOutReader; asked: () => number } {
    let asked = 0;
    return {
      reader: {
        read: async () => {
          asked += 1;
          return reading;
        },
      },
      asked: () => asked,
    };
  }

  it('is recorded by the sweep without asking the model again, through a failed attempt', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = ownText();
    const family = await heldParent(text);
    await failedLiveStop(text);
    const model = readerOf(NONE);
    const transport = new FakeTransport();

    const refused = await withRevokeRefused(() =>
      recoverHeldOptOutReads(db.database, sweepDeps(model.reader, transport, NOW)),
    );

    expect(refused.outcomes.stop_failed).toBe(1);
    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const later = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, transport, LATER),
    );

    expect(later.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(model.asked()).toBe(0);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it('runs on a redelivery the model reads as ordinary, and nothing is sent', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    await failedLiveStop(text);
    // Past the read cache, so the redelivery gets a fresh model read of the same words.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const model = readerOf(NONE);
    const redelivered = new FakeTransport();

    const outcome = await handleInboundSms(
      db.database,
      delivery(redelivered, text),
      intakeDeps(NONE, redelivered, allowed(), { optOutReader: model.reader }),
    );

    expect(model.asked()).toBe(1);
    expect(outcome).toEqual({ status: 'stopped', ack: 'voice_unsent' });
    expect(redelivered.sent).toEqual([]);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('is released without a stop when the holder verified the number again after it', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    await failedLiveStop(text);
    await db.database
      .update(schema.parentChannels)
      .set({ verifiedAt: NOW })
      .where(eq(schema.parentChannels.userId, family.parentUserId));
    const model = readerOf(NONE);

    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, new FakeTransport(), NOW),
    );

    expect(swept.outcomes.stop_superseded).toBe(1);
    expect(model.asked()).toBe(0);
    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('cannot be cleared by the operator path', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    await heldParent(text);
    await failedLiveStop(text);

    expect(await clearCollisionHold(db.database, HELD_ID)).toBe('not_a_collision_hold');
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
  }, 30_000);

  it('still runs when marking the stop pending fails, and releases afterwards', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = ownText();
    const family = await heldParent(text);
    const transport = new FakeTransport();

    const outcome = await withRefused('update', 'opt_out_held_messages', () =>
      handleInboundSms(
        db.database,
        delivery(transport, text),
        intakeDeps(STOP, transport, allowed()),
      ),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(transport.bodies()).toEqual([CONFIRMATION]);
  }, 30_000);

  it("never touches another number's hold on the same provider id", async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    await heldParent(text);
    const otherNumber = '+15555550192';
    const transport = new FakeTransport();

    const outcome = await handleInboundSms(
      db.database,
      transport.inbound(otherNumber, text, { providerId: HELD_ID, receivedAt: SENT_AT }),
      intakeDeps(STOP, transport, allowed()),
    );

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(transport.sent.map((sent) => sent.to)).toEqual([otherNumber]);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
    const [row] = await db.database
      .select({ kind: schema.optOutHeldMessages.kind })
      .from(schema.optOutHeldMessages)
      .where(eq(schema.optOutHeldMessages.providerMessageId, HELD_ID));
    expect(row?.kind).toBe(MESSAGE_HOLD);
  }, 30_000);

  it('still runs when a crisis reply to the same text was already sent', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const text = ownText();
    const family = await heldParent(text);
    await failedLiveStop(text);
    expect(await noteCrisisReplySent(db.database, HELD_ID, NOW)).toBe('marked');
    const model = readerOf(NONE);

    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, new FakeTransport(), NOW),
    );

    expect(swept.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(swept.outcomes.crisis_already_answered).toBe(0);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);
});

async function heldKind(): Promise<string | undefined> {
  const [row] = await db.database
    .select({ kind: schema.optOutHeldMessages.kind })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, HELD_ID));
  return row?.kind;
}

/** Answers each read in turn, and counts them. */
function scriptedReader(...readings: OptOutReading[]): {
  reader: OptOutReader;
  asked: () => number;
} {
  let asked = 0;
  return {
    reader: {
      read: async () => {
        const reading = readings[asked];
        asked += 1;
        if (!reading) throw new Error('read more times than the case scripted');
        return reading;
      },
    },
    asked: () => asked,
  };
}

const PAST_BACKOFF = new Date(NOW.getTime() + 16 * 60_000);

describe('a stop the recovery sweep read itself', () => {
  it('flag on: a failed stop is remembered, so a later reading of none cannot release it', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    const model = scriptedReader(STOP, NONE);
    const transport = new FakeTransport();

    const first = await withRevokeRefused(() =>
      recoverHeldOptOutReads(db.database, sweepDeps(model.reader, transport, NOW)),
    );

    expect(first.outcomes.stop_failed).toBe(1);
    expect(await heldKind()).toBe(STOP_PENDING_HOLD);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const second = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, transport, PAST_BACKOFF),
    );

    expect(second.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(second.outcomes.read_not_stop).toBe(0);
    expect(model.asked()).toBe(1);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it('flag off: the same sequence re-reads the text and releases it, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    const model = scriptedReader(STOP, NONE);
    const transport = new FakeTransport();

    const first = await withRevokeRefused(() =>
      recoverHeldOptOutReads(db.database, sweepDeps(model.reader, transport, NOW)),
    );

    expect(first.outcomes.stop_failed).toBe(1);
    expect(await heldKind()).toBe(MESSAGE_HOLD);

    const second = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, transport, PAST_BACKOFF),
    );

    expect(second.outcomes.read_not_stop).toBe(1);
    expect(model.asked()).toBe(2);
    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('flag on: a stop the timeline cannot place is remembered too', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    // The ledger names this parent for a text sent while the timeline says another held it.
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: new Date(SENT_AT.getTime() - 60_000) })
      .where(eq(schema.parentChannels.userId, family.parentUserId));
    const other = await seedFamily(db.database, 'Next Holder Family');
    await db.database.insert(schema.parentChannels).values({
      userId: other.parentUserId,
      familyId: other.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: HASH(),
      verifiedAt: new Date(SENT_AT.getTime() - 30_000),
    });
    const model = scriptedReader(STOP, NONE);
    const transport = new FakeTransport();

    const first = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, transport, NOW),
    );

    expect(first.outcomes.timeline_unresolved).toBe(1);
    expect(await heldKind()).toBe(STOP_PENDING_HOLD);

    const second = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, transport, PAST_BACKOFF),
    );

    expect(second.outcomes.timeline_unresolved).toBe(1);
    expect(second.outcomes.read_not_stop).toBe(0);
    expect(model.asked()).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
  }, 30_000);
});

describe('a stop is written down before anything else happens', () => {
  /** Reads stop, then a table the number timeline needs is gone: a real fault inside settling. */
  const stopThenTimelineBreaks: OptOutReader = {
    read: async () => {
      await db.exec('alter table party_rsvps rename to party_rsvps_away');
      return STOP;
    },
  };
  const timelineRestored = () => db.exec('alter table party_rsvps_away rename to party_rsvps');

  it('flag on: a throw while settling cannot lose the stop to a later reading of none', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    const transport = new FakeTransport();

    const first = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(stopThenTimelineBreaks, transport, NOW),
    ).finally(timelineRestored);

    expect(first.outcomes.recovery_failed).toBe(1);
    expect(await heldKind()).toBe(STOP_PENDING_HOLD);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
    expect(await channelRevoked(family.parentUserId)).toBe(false);

    const later = scriptedReader(NONE);
    const second = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(later.reader, transport, PAST_BACKOFF),
    );

    expect(second.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(second.outcomes.read_not_stop).toBe(0);
    expect(later.asked()).toBe(0);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it('flag off: the same throw leaves an ordinary row that a reading of none releases, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    const transport = new FakeTransport();

    const first = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(stopThenTimelineBreaks, transport, NOW),
    ).finally(timelineRestored);

    expect(first.outcomes.recovery_failed).toBe(1);
    expect(await heldKind()).toBe(MESSAGE_HOLD);

    const later = scriptedReader(NONE);
    const second = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(later.reader, transport, PAST_BACKOFF),
    );

    expect(second.outcomes.read_not_stop).toBe(1);
    expect(later.asked()).toBe(1);
    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('flag on: when the mark itself fails, nothing is acted on and the hold stays', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await heldParent(ownText());
    const markRefused: OptOutReader = {
      read: async () => {
        await refuseWrites('update', 'opt_out_held_messages');
        return STOP;
      },
    };

    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(markRefused, new FakeTransport(), NOW),
    ).finally(() => allowWrites('opt_out_held_messages'));

    expect(swept.outcomes.recovery_failed).toBe(1);
    expect(await heldKind()).toBe(MESSAGE_HOLD);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
    expect(await channelRevoked(family.parentUserId)).toBe(false);
    expect(await withdrawals(family.parentUserId)).toBe(0);
  }, 30_000);

  it('flag on: a stop marked and recorded in one pass is released in that pass', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    const family = await heldParent(ownText());
    const model = scriptedReader(STOP);

    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps(model.reader, new FakeTransport(), NOW),
    );

    expect(swept.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(await channelRevoked(family.parentUserId)).toBe(true);
    expect(await heldKind()).toBeUndefined();
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);
});

describe('a pending stop whose text is in no store', () => {
  async function seedInvite(
    state: typeof schema.caregiverInvites.$inferInsert.state = 'awaiting_caregiver_reply',
    { createdAt = new Date(SENT_AT.getTime() - 3_600_000) }: { createdAt?: Date } = {},
  ): Promise<void> {
    const inviter = await seedFamily(db.database, 'Inviting Family');
    await db.database.insert(schema.caregiverInvites).values({
      familyId: inviter.familyId,
      invitedByUserId: inviter.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: HASH(),
      state,
      closedAt: state === 'awaiting_caregiver_reply' ? null : new Date(SENT_AT.getTime() - 60_000),
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt,
    });
  }

  async function seedGuest(): Promise<void> {
    const host = await seedFamily(db.database, 'Hosting Family');
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId: host.familyId, title: 'A party', startsAt: NOW, source: 'parent' })
      .returning({ id: schema.familyEvents.id });
    const [invite] = await db.database
      .insert(schema.partyInvites)
      .values({
        familyId: host.familyId,
        familyEventId: event?.id as string,
        hostUserId: host.parentUserId,
        publicToken: 'party-token-stop-hold',
      })
      .returning({ id: schema.partyInvites.id });
    await db.database.insert(schema.partyRsvps).values({
      partyInviteId: invite?.id as string,
      displayName: 'Guest',
      nameKey: 'guest',
      response: 'yes',
      reminderOptInAt: new Date(SENT_AT.getTime() - 3_600_000),
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: HASH(),
    });
  }

  async function seedDraw(
    status: 'drawn' | 'cancelled' = 'drawn',
    deliveredAt: Date | null = null,
    held: { heldReason: schema.SecretSantaHeldReason | null; staleAt?: Date } | null = null,
  ): Promise<void> {
    const [person] = await db.database
      .insert(schema.linqSharedGroupPeople)
      .values({
        chatId: 'chat-stop-hold',
        phoneE164Encrypted: encryptString(PHONE),
        phoneE164Hash: HASH(),
      })
      .returning({ id: schema.linqSharedGroupPeople.id });
    const [draw] = await db.database
      .insert(schema.secretSantaDraws)
      .values({ chatId: 'chat-stop-hold', status, staleAt: held?.staleAt ?? null })
      .returning({ id: schema.secretSantaDraws.id });
    await db.database.insert(schema.secretSantaParticipants).values({
      drawId: draw?.id as string,
      personId: person?.id as string,
      deliveredAt,
      heldReason: held?.heldReason ?? null,
    });
  }

  async function heldNoText(kind: 'pending' | 'message'): Promise<void> {
    await holdSender(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID, now: SENT_AT });
    if (kind === 'pending') {
      await markStopPending(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID });
    }
  }

  /** The real stop path's writes, for a stop that committed and whose ack was all that failed. */
  async function theStopCommits(): Promise<void> {
    await handleStop(
      db.database,
      {
        phoneE164: PHONE,
        inbound: new FakeTransport().inbound(PHONE, 'x', {
          providerId: HELD_ID,
          receivedAt: SENT_AT,
        }),
        session: null,
        now: NOW,
        providerAnswered: true,
      },
      { transport: new FakeTransport() },
    );
  }

  const sweep = (now: Date) =>
    recoverHeldOptOutReads(
      db.database,
      sweepDeps(scriptedReader().reader, new FakeTransport(), now),
    );

  const records: [string, () => Promise<void>][] = [
    ['an open caregiver invite', () => seedInvite()],
    ['an expired invite nobody answered', () => seedInvite('expired')],
    ['a seat_taken invite', () => seedInvite('seat_taken')],
    ['a guest reminder opt-in', seedGuest],
    ['an undelivered Secret Santa draw', () => seedDraw()],
    [
      'a draw whose 1:1 could not open',
      () => seedDraw('drawn', null, { heldReason: 'cannot_open_1to1' }),
    ],
  ];

  it.each(records)(
    'stays held and paged while the number has %s',
    async (_name, seed) => {
      vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
      await seed();
      await heldNoText('pending');

      const first = await sweep(NOW);

      expect(first.outcomes.unrecorded).toBe(1);
      expect(first.outcomes.no_channel).toBe(0);
      expect(await isSenderHeld(db.database, HASH())).toBe(true);
      const posted: string[] = [];
      await pageFailureAlerts(db.database, {
        now: NOW,
        post: async (line) => {
          posted.push(line);
          return 'sent';
        },
      });
      expect(posted).toEqual([
        'Hale: opt-out reads held. messages 1. numbers 1. not in ledger 1. legacy 0. oldest 0h.',
      ]);

      await theStopCommits();
      const second = await sweep(PAST_BACKOFF);

      expect(second.outcomes.no_channel).toBe(1);
      expect(second.outcomes.unrecorded).toBe(0);
      expect(await isSenderHeld(db.database, HASH())).toBe(false);
    },
    30_000,
  );

  it('releases on the record of its stop, not on the invite it declined, when an older invite outlives it', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    await seedInvite('expired', { createdAt: new Date(SENT_AT.getTime() - 7_200_000) });
    await seedInvite('seat_taken');
    await heldNoText('pending');

    expect((await sweep(NOW)).outcomes.unrecorded).toBe(1);

    await theStopCommits();
    const unrecorded = await sweep(PAST_BACKOFF);

    const states = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites);
    expect(states.map((row) => row.state).sort()).toEqual(['declined', 'expired']);
    expect(unrecorded.outcomes.unrecorded).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    await recordStopRan(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID });
    const recorded = await sweep(new Date(PAST_BACKOFF.getTime() + 31 * 60_000));

    expect(recorded.outcomes.already_stopped).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('is not released by a decline from before the hold', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    await seedInvite('declined', { createdAt: new Date(SENT_AT.getTime() - 7_200_000) });
    await seedInvite('expired');
    await heldNoText('pending');

    const swept = await sweep(NOW);

    expect(swept.outcomes.unrecorded).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
  }, 30_000);

  it('holds a draw whose 1:1 could not open until the stop marks it opted out', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    await seedDraw('drawn', null, { heldReason: 'cannot_open_1to1' });
    await heldNoText('pending');

    expect((await sweep(NOW)).outcomes.unrecorded).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    await theStopCommits();
    const [participant] = await db.database
      .select({ heldReason: schema.secretSantaParticipants.heldReason })
      .from(schema.secretSantaParticipants);
    expect(participant?.heldReason).toBe('opted_out');

    expect((await sweep(PAST_BACKOFF)).outcomes.no_channel).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('is released once nothing remains on the number', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
    await heldNoText('pending');

    const swept = await sweep(NOW);

    expect(swept.outcomes.no_channel).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it.each<[string, () => Promise<void>]>([
    ['a delivered draw', () => seedDraw('drawn', new Date(SENT_AT.getTime() - 60_000))],
    ['a cancelled draw', () => seedDraw('cancelled')],
    ['a draw gone stale', () => seedDraw('drawn', null, { heldReason: null, staleAt: SENT_AT })],
    ['a row held as draw_stale', () => seedDraw('drawn', null, { heldReason: 'draw_stale' })],
    ['a row held as claim_stuck', () => seedDraw('drawn', null, { heldReason: 'claim_stuck' })],
    ['a row a group stop held', () => seedDraw('drawn', null, { heldReason: 'stopped' })],
    ['an invite the person accepted', () => seedInvite('accepted')],
    ['an invite the person declined', () => seedInvite('declined')],
  ])(
    'is released when the only record is %s',
    async (_name, seed) => {
      vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
      await seed();
      await heldNoText('pending');

      const swept = await sweep(NOW);

      expect(swept.outcomes.no_channel).toBe(1);
      expect(await isSenderHeld(db.database, HASH())).toBe(false);
    },
    30_000,
  );

  it.each(records)(
    'an ordinary unread hold with %s is released, as on main',
    async (_name, seed) => {
      vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
      await seed();
      await heldNoText('message');

      const swept = await sweep(NOW);

      expect(swept.outcomes.no_channel).toBe(1);
      expect(await isSenderHeld(db.database, HASH())).toBe(false);
    },
    30_000,
  );
});

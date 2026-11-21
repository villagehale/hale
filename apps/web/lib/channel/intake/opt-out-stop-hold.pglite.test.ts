import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { threadIfParent } from '~/lib/channel/thread';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { failurePageCrisisPager, pageFailureAlerts } from '~/lib/monitoring/failure-page';
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
import { type IntakeDeps, handleInboundSms } from './machine';
import { holdSender, isSenderHeld } from './opt-out-hold';
import type { OptOutReading } from './opt-out-reader';
import { recoverHeldOptOutReads } from './opt-out-recovery';
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
    'truncate table opt_out_held_messages, opt_out_read_holds, channel_messages, parent_channels, consent_records, audit_log, sms_intake_sessions, caregiver_invites, rate_limits, family_members, families, users cascade',
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

/** A real database fault on one table's updates, not a mock of the code that writes it. */
async function withUpdatesRefused<T>(
  table: 'parent_channels' | 'sms_intake_sessions',
  run: () => Promise<T>,
): Promise<T> {
  await db.exec(`
    create function refuse_update() returns trigger language plpgsql
      as $$ begin raise exception '${REFUSED}'; end $$;
    create trigger refuse_update before update on ${table}
      for each row execute function refuse_update();
  `);
  try {
    return await run();
  } finally {
    await db.exec(`drop trigger refuse_update on ${table}; drop function refuse_update();`);
  }
}

const withRevokeRefused = <T>(run: () => Promise<T>): Promise<T> =>
  withUpdatesRefused('parent_channels', run);

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
    const unusedWriter: SaidLineWriter = {
      write: async () => {
        throw new Error('a stop is never written by the crisis writer');
      },
    };
    const result = await recoverHeldOptOutReads(db.database, {
      reader: { read: async () => STOP },
      transport: sweepTransport,
      saidLine: unusedWriter,
      threadMessage: threadIfParent,
      crisisPager: failurePageCrisisPager(db.database, {
        now: NOW,
        post: async () => 'sent',
      }),
      preflight: async () => ({ proceed: true, health: null }),
      now: NOW,
    });

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

    const outcome = await handleInboundSms(
      db.database,
      delivery(transport, text),
      intakeDeps(STOP, transport, allowed(), {
        optOutHold: {
          hold: async () => {},
          settled: async () => {
            throw new Error('hold store down');
          },
        },
      }),
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
      withUpdatesRefused('sms_intake_sessions', () =>
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

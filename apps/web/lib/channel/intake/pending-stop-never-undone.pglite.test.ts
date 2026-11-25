import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type InboundRouteDeps,
  type InboundRouteOutcome,
  routeInboundText,
} from '~/lib/channel/inbound-route';
import { createLinqPhoneTransport } from '~/lib/channel/linq/transport';
import { HANDOFF_GRACE_MS, selectUnhandedInbound } from '~/lib/channel/reconcile/unhanded';
import { threadIfParent } from '~/lib/channel/thread';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { failurePageCrisisPager } from '~/lib/monitoring/failure-page';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from './fakes';
import type { IntakeDeps } from './machine';
import { holdSender, isSenderHeld, markStopPending } from './opt-out-hold';
import type { OptOutReader, OptOutReading } from './opt-out-reader';
import {
  type OptOutRecoveryDeps,
  heldReadBackoff,
  recoverHeldOptOutReads,
} from './opt-out-recovery';
import {
  OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV,
  OPT_OUT_UNREAD_HOLD_TURN_ENV,
} from './opt-out-turn-flags';
import { FakeTransport } from './transport';

/**
 * A stop that is pending on a held text is the parent's instruction, and nothing undoes it:
 * not a redelivery of the same words read as a start, not a sweep tick that read the row's
 * kind before the stop was marked, and not an invite declined for another reason. Through
 * the real inbound door, the real Linq transport and the real recovery sweep on pglite;
 * only Linq's HTTP and the model readers are scripted (rule #8).
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+15555550193';
const HALE_LINE = '+15555550100';
const HASH = () => phoneBlindIndex(PHONE);
const HELD_ID = 'pm-pending-stop';
const NOW = new Date('2026-11-24T15:00:00.000Z');
const SENT_AT = new Date(NOW.getTime() - 20 * 60_000);
const PAST_BACKOFF = new Date(NOW.getTime() + heldReadBackoff(1) + 60_000);
const STOP_CONFIRMATION = 'Understood, I will leave you be.';
const WELCOME_BACK = 'Welcome back, glad to have you.';
const STOP: OptOutReading = { intent: 'stop', confirmation: STOP_CONFIRMATION, language: 'en' };
const START: OptOutReading = { intent: 'start', confirmation: WELCOME_BACK, language: 'en' };
const NONE: OptOutReading = { intent: 'none', confirmation: '', language: 'en' };
const REFUSED = 'refused for the test';

/** Linq's HTTP, scripted: every request it was sent, and whether it is up. */
class LinqScript {
  readonly requests: string[] = [];
  up = true;
  private sent = 0;
  readonly fetch = (async (_url: string, init?: { body?: string }) => {
    this.requests.push(init?.body ?? '');
    if (!this.up) return new Response('unavailable', { status: 503 });
    this.sent += 1;
    return Response.json(
      { chat: { id: 'chat-1', message: { id: `linq-out-${this.sent}` } } },
      { status: 201 },
    );
  }) as unknown as typeof fetch;
}

let texts = 0;
/** The read cache is keyed on the words for a minute, so every case texts its own. */
function ownText(): string {
  texts += 1;
  return `we are done here, note ${texts}`;
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
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', HALE_LINE);
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
  vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'true');
  vi.stubEnv(OPT_OUT_UNREAD_HOLD_TURN_ENV, 'true');
  vi.stubGlobal('fetch', async () => {
    throw new Error('no network in this test');
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec(
    'truncate table opt_out_held_messages, opt_out_read_holds, channel_messages, parent_channels, consent_records, audit_log, sms_intake_sessions, caregiver_invites, rate_limits, family_members, families, users cascade',
  );
});

async function enrolledParent(): Promise<{ familyId: string; parentUserId: string }> {
  const family = await seedFamily(db.database, 'Pending Stop Family');
  await db.database.insert(schema.parentChannels).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: HASH(),
    verifiedAt: new Date(NOW.getTime() - 7 * 24 * 3_600_000),
  });
  return family;
}

/** The inbound door with the real Linq transport; the opt-out reader answers `reading`. */
function door(linq: LinqScript, reading: () => OptOutReading | null) {
  const jobs: unknown[] = [];
  const counted: InboundRouteOutcome[] = [];
  const intake: IntakeDeps = {
    transport: createLinqPhoneTransport({ fetch: linq.fetch }),
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    optOutReader: { read: async () => reading() },
    now: NOW,
  };
  const deps: InboundRouteDeps = {
    database: db.database,
    intake: () => intake,
    enqueue: async (job) => {
      jobs.push(job);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async (outcome) => {
      counted.push(outcome);
    },
    now: () => NOW,
  };
  return { deps, jobs };
}

function delivery(text: string, providerId = HELD_ID) {
  return new FakeTransport().inbound(PHONE, text, { providerId, receivedAt: SENT_AT });
}

/** Past the minute the read cache keeps a text's reading, so a redelivery is read afresh. */
function pastReadCache(): void {
  const later = Date.now() + 61_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
}

const unusedWriter: SaidLineWriter = {
  write: async () => {
    throw new Error('a stop is never written by the crisis writer');
  },
};

function sweepDeps(reader: OptOutReader, linq: LinqScript, now: Date): OptOutRecoveryDeps {
  return {
    reader,
    transport: createLinqPhoneTransport({ fetch: linq.fetch }),
    saidLine: unusedWriter,
    threadMessage: threadIfParent,
    crisisPager: failurePageCrisisPager(db.database, { now, post: async () => 'sent' }),
    preflight: async () => ({ proceed: true, health: null }),
    now,
  };
}

/** A real database fault on one table's writes, not a mock of the code that writes it. */
async function withRefused<T>(
  operation: 'update' | 'delete',
  table: 'parent_channels' | 'opt_out_held_messages',
  run: () => Promise<T>,
): Promise<T> {
  await db.exec(`
    create function refuse_write() returns trigger language plpgsql
      as $$ begin raise exception '${REFUSED}'; end $$;
    create trigger refuse_write before ${operation} on ${table}
      for each row execute function refuse_write();
  `);
  try {
    return await run();
  } finally {
    await db.exec(`drop trigger refuse_write on ${table}; drop function refuse_write();`);
  }
}

async function liveChannels(): Promise<number> {
  const rows = await db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, HASH()));
  return rows.filter((row) => row.revokedAt === null).length;
}

async function withdrawals(parentUserId: string): Promise<number> {
  const rows = await db.database
    .select({ granted: schema.consentRecords.granted })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.userId, parentUserId));
  return rows.filter((row) => row.granted === false).length;
}

async function heldKind(): Promise<string | null> {
  const [row] = await db.database
    .select({ kind: schema.optOutHeldMessages.kind })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, HELD_ID));
  return row?.kind ?? null;
}

async function owedToCoach(providerMessageId: string): Promise<boolean> {
  const [row] = await db.database
    .select({ createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, providerMessageId));
  const owed = await selectUnhandedInbound(
    db.database,
    new Date((row?.createdAt ?? NOW).getTime() + HANDOFF_GRACE_MS + 1_000),
  );
  return owed.some((item) => item.providerMessageId === providerMessageId);
}

describe('a pending stop redelivered and read as a start', () => {
  /** Held unread, then read as a stop whose confirmation Linq could not take, then
   * redelivered and read as a start. Returns how many Linq requests came before the start. */
  async function stopThenStart(linq: LinqScript): Promise<number> {
    // The first read fails: the text is held unread.
    const text = ownText();
    expect(await routeInboundText(door(linq, () => null).deps, delivery(text))).toBe(
      'opt_out_held',
    );
    // The redelivery reads stop. The revocation commits; Linq is down for the confirmation.
    pastReadCache();
    linq.up = false;
    await expect(routeInboundText(door(linq, () => STOP).deps, delivery(text))).rejects.toThrow();
    expect(await liveChannels()).toBe(0);
    // The provider redelivers again, and this time the model reads the same words as a start.
    pastReadCache();
    linq.up = true;
    const before = linq.requests.length;
    await routeInboundText(door(linq, () => START).deps, delivery(text));
    return before;
  }

  it('runs the stop: the number stays stopped, no welcome-back goes, the stop is recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await enrolledParent();
    const linq = new LinqScript();

    const before = await stopThenStart(linq);

    expect(linq.requests.slice(before)).toEqual([]);
    expect(await liveChannels()).toBe(0);
    expect(await withdrawals(family.parentUserId)).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);

    // Nothing is left for the sweep to undo or send.
    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps({ read: async () => NONE }, linq, PAST_BACKOFF),
    );
    expect(swept.outcomes.stop_superseded).toBe(0);
    expect(await liveChannels()).toBe(0);
    expect(linq.requests.slice(before)).toEqual([]);
  }, 30_000);

  it('flag off: the start re-enrols and is welcomed back, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enrolledParent();
    const linq = new LinqScript();

    const before = await stopThenStart(linq);

    expect(linq.requests.slice(before)).toHaveLength(1);
    expect(linq.requests[before]).toContain(WELCOME_BACK);
    expect(await liveChannels()).toBe(1);
  }, 30_000);

  it('positive control: a stop ends with one model-written confirmation, then silence', async () => {
    await enrolledParent();
    const text = ownText();
    const linq = new LinqScript();

    expect(await routeInboundText(door(linq, () => null).deps, delivery(text))).toBe(
      'opt_out_held',
    );
    pastReadCache();
    await routeInboundText(door(linq, () => STOP).deps, delivery(text));

    expect(linq.requests).toHaveLength(1);
    expect(linq.requests[0]).toContain(STOP_CONFIRMATION);
    expect(await liveChannels()).toBe(0);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);

    const later = door(linq, () => NONE);
    await routeInboundText(later.deps, delivery(ownText(), 'pm-after-stop'));
    expect(linq.requests).toHaveLength(1);
    expect(later.jobs).toEqual([]);
  }, 30_000);
});

describe('a sweep tick that read the row before a stop was marked on it', () => {
  /** Held unread; then, while the sweep's model read is out, the provider redelivers the
   * text, the live turn reads stop and marks it pending, and the revocation fails. */
  async function markedMidTick(linq: LinqScript): Promise<void> {
    const text = ownText();
    expect(await routeInboundText(door(linq, () => null).deps, delivery(text))).toBe(
      'opt_out_held',
    );
    pastReadCache();
    const midTick: OptOutReader = {
      read: async () => {
        await expect(
          withRefused('update', 'parent_channels', () =>
            routeInboundText(door(linq, () => STOP).deps, delivery(text)),
          ),
        ).rejects.toThrow(REFUSED);
        return NONE;
      },
    };
    await recoverHeldOptOutReads(db.database, sweepDeps(midTick, linq, NOW));
  }

  it('hands nothing to the coach when the stop write then fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await enrolledParent();
    const linq = new LinqScript();

    await markedMidTick(linq);

    expect(await owedToCoach(HELD_ID)).toBe(false);
    expect(await heldKind()).toBe('stop_pending');
    expect(linq.requests).toEqual([]);

    // The next tick records the stop, and nothing is sent.
    const next = await recoverHeldOptOutReads(
      db.database,
      sweepDeps({ read: async () => NONE }, linq, PAST_BACKOFF),
    );
    expect(next.outcomes.stopped_late_unconfirmed).toBe(1);
    expect(await liveChannels()).toBe(0);
    expect(await owedToCoach(HELD_ID)).toBe(false);
    expect(linq.requests).toEqual([]);
  }, 30_000);

  it('flag off: the text is handed to the coach, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await enrolledParent();

    await markedMidTick(new LinqScript());

    expect(await owedToCoach(HELD_ID)).toBe(true);
  }, 30_000);

  it('positive control: an ordinary held text still goes to the coach once its hold clears', async () => {
    await enrolledParent();
    const text = ownText();
    const linq = new LinqScript();
    expect(await routeInboundText(door(linq, () => null).deps, delivery(text))).toBe(
      'opt_out_held',
    );

    const swept = await recoverHeldOptOutReads(
      db.database,
      sweepDeps({ read: async () => NONE }, linq, NOW),
    );

    expect(swept.outcomes.read_not_stop).toBe(1);
    expect(await owedToCoach(HELD_ID)).toBe(true);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(linq.requests).toEqual([]);
  }, 30_000);
});

describe('a pending stop whose text is in no store, on a number with invites', () => {
  async function invite(
    state: typeof schema.caregiverInvites.$inferInsert.state,
    createdAt: Date,
    closedAt: Date | null,
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
      closedAt,
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt,
    });
  }

  async function pendingStopWithNoText(): Promise<void> {
    await holdSender(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID, now: SENT_AT });
    await markStopPending(db.database, { phoneHash: HASH(), providerMessageId: HELD_ID });
  }

  const sweep = (linq: LinqScript, now: Date) =>
    recoverHeldOptOutReads(db.database, sweepDeps({ read: async () => NONE }, linq, now));

  /** An older invite nobody answered, and a newer one the inviting parent withdrew after
   * the hold. No stop ran on this number. */
  async function declinedForAnotherReason(): Promise<void> {
    await invite(
      'expired',
      new Date(SENT_AT.getTime() - 7_200_000),
      new Date(SENT_AT.getTime() - 3_600_000),
    );
    await invite(
      'declined',
      new Date(SENT_AT.getTime() - 3_600_000),
      new Date(NOW.getTime() - 60_000),
    );
    await pendingStopWithNoText();
  }

  it('is not released by an invite declined for another reason since the hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await declinedForAnotherReason();
    const linq = new LinqScript();

    const swept = await sweep(linq, NOW);

    expect(swept.outcomes.no_channel).toBe(0);
    expect(swept.outcomes.unrecorded).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
    expect(linq.requests).toEqual([]);
  }, 30_000);

  it('flag off: the decline releases it, as on main', async () => {
    vi.stubEnv(OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENV, 'false');
    await declinedForAnotherReason();

    const swept = await sweep(new LinqScript(), NOW);

    expect(swept.outcomes.no_channel).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
  }, 30_000);

  it('positive control: is released once its stop ran and was recorded, though an older invite outlives it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await invite(
      'expired',
      new Date(SENT_AT.getTime() - 7_200_000),
      new Date(SENT_AT.getTime() - 3_600_000),
    );
    await invite(
      'seat_taken',
      new Date(SENT_AT.getTime() - 3_600_000),
      new Date(SENT_AT.getTime() - 60_000),
    );
    await pendingStopWithNoText();
    const linq = new LinqScript();

    // The provider redelivers the stop. It runs and closes the newest unanswered invite;
    // only the release of its hold fails.
    await withRefused('delete', 'opt_out_held_messages', () =>
      routeInboundText(door(linq, () => STOP).deps, delivery(ownText())),
    );
    expect(linq.requests).toHaveLength(1);
    expect(linq.requests[0]).toContain(STOP_CONFIRMATION);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);

    const swept = await sweep(linq, NOW);

    expect(swept.outcomes.already_stopped).toBe(1);
    const states = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites);
    expect(states.map((row) => row.state).sort()).toEqual(['declined', 'expired']);
    expect(await isSenderHeld(db.database, HASH())).toBe(false);
    expect(linq.requests).toHaveLength(1);
  }, 30_000);

  it('positive control: a stop that never ran stays held while an unanswered invite stands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await invite(
      'expired',
      new Date(SENT_AT.getTime() - 7_200_000),
      new Date(SENT_AT.getTime() - 3_600_000),
    );
    await pendingStopWithNoText();

    const swept = await sweep(new LinqScript(), NOW);

    expect(swept.outcomes.unrecorded).toBe(1);
    expect(await isSenderHeld(db.database, HASH())).toBe(true);
  }, 30_000);
});

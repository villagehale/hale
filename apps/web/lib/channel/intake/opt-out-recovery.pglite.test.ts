import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaneReading } from '~/lib/channel/off-domain/screen';
import { type OffDomainPorts, crisisMarkingLane } from '~/lib/channel/off-domain/lane';
import type { Moment } from '~/lib/channel/off-domain/moment-reply';
import { threadIfParent } from '~/lib/channel/thread';
import {
  type SaidLineWriter,
  createSaidLineWriter,
  crisisReplyViolation,
} from '~/lib/channel/voice/said-line';
import {
  resolveSendablePhone,
  resolveVerifiedChannelByPhone,
} from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import {
  CRISIS_ANSWERED_ROUTE,
  CRISIS_UNANSWERED_PAGE_ROUTE,
  crisisReplyState,
  failurePageCrisisPager,
  noteCrisisReplySent,
  pageFailureAlerts,
} from '~/lib/monitoring/failure-page';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { runDeletionSweep } from '~/lib/rights/delete';
import { assembleFamilyExport } from '~/lib/rights/export';
import { INTAKE_CONTENT_REDACTED } from '~/lib/rights/message-retention';
import { NO_TEEN_UNLOCKS } from '~/lib/teen-access';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { recordedModel } from '~/lib/testing/recorded-model';
import { reenrolOnStart } from './channel-state';
import { holdSender, isSenderHeld } from './opt-out-hold';
import type { OptOutReadInput, OptOutReader, OptOutReading } from './opt-out-reader';
import {
  HELD_READ_BATCH,
  OPT_OUT_RECOVERY_BUDGET_MS,
  type OptOutRecoveryDeps,
  heldReadBackoff,
  recoverHeldOptOutReads,
  resolveHeldText,
} from './opt-out-recovery';
import { scriptedFriendVoice } from './scripted-friend-voice.fixture';
import { SCRIPTED_STOP_CONFIRMATION, scriptedOptOutRead } from './scripted-opt-out-reader.fixture';
import { createSession, loadOpenSession, saveSession } from './session';
import { runSittingReminderCron } from './sitting-reminder';
import { FakeTransport } from './transport';

/**
 * VIL-553 · a stop that arrived while the model was down is re-read by message, never
 * lost. Against the real DDL because the claim, the back-off order, the legacy re-point
 * and the stop path's ledger rows are all SQL. The reader is a fake at its port (rule #8):
 * what the model says about a text is the eval harness's job, not this file's.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MINUTE = 60_000;
const PHONE_A = '+15555550101';
const PHONE_B = '+15555550102';
const PHONE_C = '+15555550103';
const PHONE_D = '+15555550104';

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
  posted = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec(
    'truncate table opt_out_held_messages, opt_out_read_holds, channel_messages, parent_channels, consent_records, audit_log, sms_intake_sessions, caregiver_invites, rate_limits, family_members, families, users cascade',
  );
});

const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);

/** An Eastern forward sortation area alone, which gives a family its own clock (Eastern time). */
const EASTERN_FSA = 'K2P';

async function parent(
  phone: string,
  over: { revoked?: boolean; verifiedAt?: Date; place?: string } = {},
): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Held Family');
  await channel(seeded, phone, {
    verifiedAt: over.verifiedAt ?? ago(60 * 24 * 7),
    revokedAt: over.revoked ? ago(60) : null,
  });
  if (over.place) {
    await db.database
      .update(schema.families)
      .set({ postalCode: over.place })
      .where(eq(schema.families.id, seeded.familyId));
  }
  return seeded;
}

async function channel(
  owner: { familyId: string; parentUserId: string },
  phone: string,
  at: { verifiedAt: Date | null; revokedAt: Date | null; createdAt?: Date },
): Promise<void> {
  await db.database.insert(schema.parentChannels).values({
    userId: owner.parentUserId,
    familyId: owner.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: at.verifiedAt,
    revokedAt: at.revokedAt,
    ...(at.createdAt ? { createdAt: at.createdAt } : {}),
  });
}

/** An intake session on `phone` whose transcript holds `entries`, started at the first. */
async function intake(
  phone: string,
  entries: {
    providerId: string;
    body: string;
    at: Date;
    channel?: 'sms' | 'imessage';
    chatId?: string;
  }[],
  over: {
    createdAt?: Date;
    closedAt?: Date;
    owner?: { familyId: string; parentUserId: string };
    /** A postal area the first touch gave, which gives the session its own clock. */
    place?: string;
  } = {},
): Promise<string> {
  const session = await createSession(db.database, {
    phoneE164: phone,
    state: 'awaiting_details',
    sourceCode: null,
  });
  const [first] = entries;
  if (!first) throw new Error('intake: a session needs one inbound');
  await saveSession(
    db.database,
    session,
    {
      transcript: entries.map((entry) => ({
        direction: 'in' as const,
        body: entry.body,
        providerId: entry.providerId,
        at: entry.at.toISOString(),
        ...(entry.channel ? { channel: entry.channel } : {}),
        ...(entry.chatId ? { chatId: entry.chatId } : {}),
      })),
      lastProviderId: entries[entries.length - 1]?.providerId ?? first.providerId,
      ...(over.place
        ? {
            firstTouch: {
              language: 'en' as const,
              place: {
                kind: 'postal' as const,
                areaCoarse: over.place,
                postalCode: null,
                municipality: null,
                city: null,
              },
              locationRequest: null,
            },
          }
        : {}),
      ...(over.closedAt ? { state: 'superseded' as const, closedAt: over.closedAt } : {}),
      ...(over.owner ? { familyId: over.owner.familyId, userId: over.owner.parentUserId } : {}),
    },
    over.closedAt ?? first.at,
  );
  await db.database
    .update(schema.smsIntakeSessions)
    .set({ createdAt: over.createdAt ?? first.at })
    .where(eq(schema.smsIntakeSessions.id, session.id));
  return session.id;
}

async function sessionRow(id: string) {
  const [row] = await db.database
    .select({ state: schema.smsIntakeSessions.state, closedAt: schema.smsIntakeSessions.closedAt })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.id, id));
  return row ?? null;
}

async function withdrawals(): Promise<string[]> {
  const rows = await db.database
    .select({ userId: schema.consentRecords.userId })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.granted, false));
  return rows.map((row) => row.userId);
}

async function activeChannelOn(parentUserId: string, phone: string): Promise<boolean> {
  const rows = await db.database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.userId, parentUserId),
        eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(phone)),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  return rows.length === 1;
}

async function inboundRow(
  owner: { familyId: string; parentUserId: string },
  providerMessageId: string,
  body: string,
  sentAt: Date,
  over: { inGroup?: boolean; chatId?: string; channel?: 'email' } = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.parentUserId,
      channel: over.channel ?? (over.chatId ? 'imessage' : 'sms'),
      direction: 'in',
      category: 'reply',
      providerMessageId,
      providerChatId: over.chatId ?? null,
      status: 'delivered',
      body,
      inGroup: over.inGroup ?? null,
      sentAt,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('inboundRow: insert returned no row');
  return row.id;
}

async function hold(
  phone: string,
  providerMessageId: string,
  heldAt: Date,
  nextReadAt: Date = heldAt,
): Promise<void> {
  await db.database.insert(schema.optOutHeldMessages).values({
    providerMessageId,
    phoneHash: phoneBlindIndex(phone),
    heldAt,
    nextReadAt,
  });
}

async function heldRow(providerMessageId: string) {
  const [row] = await db.database
    .select()
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, providerMessageId));
  return row ?? null;
}

/** A reader keyed by text: the scripted stand-in, overridden per text. */
function reader(overrides: Record<string, OptOutReading | null> = {}): {
  reader: OptOutReader;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    reader: {
      read: async (input) => {
        texts.push(input.text);
        return input.text in overrides
          ? (overrides[input.text] ?? null)
          : scriptedOptOutRead(input.text);
      },
    },
  };
}

/** Slack, faked at the crisis pager's post: what #ops would have read. */
let posted: string[] = [];

const LATE_CRISIS_RECORDING = join(__dirname, '__recordings__', 'late-crisis-reply.json');

/** The real said-line writer over the crisis-reply eval's recorded reply (rule #8). */
function recordedCrisisWriter(): { writer: SaidLineWriter; misses: string[] } {
  const recorded = recordedModel(LATE_CRISIS_RECORDING, () =>
    budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS),
  );
  return { writer: createSaidLineWriter(recorded.client), misses: recorded.misses };
}

/** The real writer with its provider down: the failure injection, never a stand-in reply. */
const downWriter = createSaidLineWriter(() => {
  throw new Error('provider down');
});

/** A stop or not-stop row never reaches the crisis writer. */
const unusedWriter: SaidLineWriter = {
  write: async () => {
    throw new Error('this row is not a crisis: the crisis writer is never asked');
  },
};

function deps(
  r: OptOutReader,
  transport: FakeTransport,
  over: Partial<OptOutRecoveryDeps> = {},
): OptOutRecoveryDeps {
  const now = over.now ?? NOW;
  return {
    reader: r,
    transport,
    preflight: async () => ({ proceed: true, health: null }),
    now,
    saidLine: unusedWriter,
    threadMessage: threadIfParent,
    crisisPager: failurePageCrisisPager(db.database, {
      now,
      post: async (text) => {
        posted.push(text);
        return 'sent';
      },
    }),
    ...over,
  };
}

/** Every table a crisis claim or a held text lives in, by name, where a row holds `word`. */
async function rowsNaming(word: string): Promise<string[]> {
  const { rows } = await db.client.query<{ source: string; row: string }>(
    `select 'rate_limits' as source, row_to_json(r)::text as row from rate_limits r
     union all select 'opt_out_held_messages', row_to_json(h)::text from opt_out_held_messages h
     union all select 'audit_log', row_to_json(a)::text from audit_log a`,
  );
  return rows.filter((row) => row.row.includes(word)).map((row) => row.source);
}

async function crisisClaimIds(): Promise<string[]> {
  const rows = await db.database
    .select({ id: schema.rateLimits.id })
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE));
  return rows.map((row) => row.id);
}

/** An intake-only French sender whose held text is `body`, no place known. */
async function frenchIntake(phone: string, providerId: string, body: string): Promise<string> {
  const id = await intake(phone, [{ providerId, body, at: ago(20) }]);
  await hold(phone, providerId, ago(20));
  return id;
}

const FR_CRISIS = "je n'en peux plus";
const FR_MENTAL: OptOutReading = { intent: 'crisis_mental', confirmation: '', language: 'fr' };

/** The read rows: about the parent who texted, with no outcome a family surface could show. */
async function auditReads(familyId: string): Promise<unknown[]> {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      targetTable: schema.auditLog.targetTable,
      targetId: schema.auditLog.targetId,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'opt_out_hold_read'),
      ),
    );
}

function readRow(parentUserId: string) {
  return { actor: 'system', targetTable: 'users', targetId: parentUserId, after: null };
}

async function auditVerbs(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ action: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows.map((row) => row.action).sort();
}

/** Hale's outbound ledger rows to this parent. */
async function outboundFor(parentUserId: string) {
  return db.database
    .select({ providerMessageId: schema.channelMessages.providerMessageId })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'out'),
      ),
    );
}

/** The roles of every coach-thread message held in this family. */
async function threadRoles(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ role: schema.messages.role })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(eq(schema.conversations.familyId, familyId));
  return rows.map((row) => row.role);
}

/**
 * The off-domain lane as production builds it, its model-backed ports faked as
 * lane.test.ts fakes them: the screen read the text as a mental-health crisis and the
 * moment writer either wrote a reply or could not. Only the mark is under test here.
 */
function liveLane(moment: 'written' | 'unwritten'): {
  lane: ReturnType<typeof crisisMarkingLane>;
  moments: Moment[];
} {
  const moments: Moment[] = [];
  const read: LaneReading = {
    lane: 'safety_critical',
    category: 'mental-health',
    fallback: null,
    language: 'fr',
  };
  const ports: OffDomainPorts = {
    screen: { read: async () => read },
    answer: {
      compose: async () => {
        throw new Error('a crisis is never composed as a general answer');
      },
      continueAsk: async () => ({ status: 'unrelated' }),
    },
    moment: {
      write: async (_text, which) => {
        moments.push(which);
        return moment === 'written'
          ? { status: 'written', reply: 'live crisis reply' }
          : { status: 'unwritten', reason: 'model_failed' };
      },
    },
    today: async () => '2026-10-20',
    place: async () => ({ status: 'unknown', reason: 'no_postal' }),
    pendingAsk: async () => ({ status: 'none' }),
    medical: {
      answer: async () => {
        throw new Error('not a medical text');
      },
    },
    recordUnmetIntent: async () => 'recorded',
  };
  return { lane: crisisMarkingLane(db.database, ports), moments };
}

async function channelRevoked(parentUserId: string): Promise<boolean> {
  const [row] = await db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, parentUserId));
  return row?.revokedAt != null;
}

describe('recoverHeldOptOutReads', () => {
  it('a: a stop read late revokes, writes the ledger and audit rows, and confirms once', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    const b = await parent(PHONE_B, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-a', 'please stop texting me', ago(20));
    await hold(PHONE_A, 'pm-a', ago(20));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));

    expect(result.outcomes.stopped).toBe(1);
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(await channelRevoked(b.parentUserId)).toBe(false);
    const consent = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, a.parentUserId));
    expect(consent).toEqual([{ granted: false }]);
    // The stop path's own rows: the revoke, the confirmation's outbound ledger audit, and
    // this pass's record of what the held text read as.
    expect(await auditVerbs(a.familyId)).toEqual([
      'channel_sms_revoked',
      'opt_out_hold_read',
      'sms_intake_outbound',
    ]);
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    const outbound = await db.database
      .select({ providerMessageId: schema.channelMessages.providerMessageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, a.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ providerMessageId: 'fake-out-1' }]);
    expect(await heldRow('pm-a')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
  }, 30_000);

  it('b, m: a not-stop releases only its row; a row not yet due is left for its time', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-1', 'see you at the park', ago(30));
    await inboundRow(a, 'pm-2', 'running late today', ago(20));
    await hold(PHONE_A, 'pm-1', ago(30));
    await hold(PHONE_A, 'pm-2', ago(20), new Date(NOW.getTime() + 5 * MINUTE));
    const transport = new FakeTransport();
    const r = reader();

    const first = await recoverHeldOptOutReads(db.database, deps(r.reader, transport));
    expect(first.outcomes.read_not_stop).toBe(1);
    expect(r.texts).toEqual(['see you at the park']);
    expect(await heldRow('pm-1')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);

    const later = new Date(NOW.getTime() + 6 * MINUTE);
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { now: later }),
    );
    expect(second.outcomes.read_not_stop).toBe(1);
    expect(r.texts).toEqual(['see you at the park', 'running late today']);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
    expect(transport.sent).toEqual([]);
    expect(await auditReads(a.familyId)).toEqual([
      readRow(a.parentUserId),
      readRow(a.parentUserId),
    ]);
  }, 30_000);

  it('c: a text the model never reads backs off alone; the stop behind it is read', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-old', 'garbled text', ago(30));
    await inboundRow(a, 'pm-new', 'stop texting me now', ago(10));
    await hold(PHONE_A, 'pm-old', ago(30));
    await hold(PHONE_A, 'pm-new', ago(10));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ 'garbled text': null }).reader, transport),
    );

    expect(result.outcomes).toMatchObject({ read_failed: 1, stopped: 1 });
    const poison = await heldRow('pm-old');
    expect(poison?.readAttempts).toBe(1);
    expect(poison?.nextReadAt.getTime()).toBe(NOW.getTime() + 15 * MINUTE);
    expect(await heldRow('pm-new')).toBeNull();
  }, 30_000);

  it('d: a full batch of unrecorded rows cannot keep a newer stop from being read', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    for (let i = 0; i < HELD_READ_BATCH; i += 1) {
      await hold(PHONE_A, `pm-lost-${i}`, ago(60 + i));
    }
    await inboundRow(a, 'pm-stop', 'stop texting me', ago(1));
    await hold(PHONE_A, 'pm-stop', ago(1));
    const transport = new FakeTransport();
    const r = reader();

    const first = await recoverHeldOptOutReads(db.database, deps(r.reader, transport));
    expect(first.outcomes.unrecorded).toBe(HELD_READ_BATCH);
    expect(first.outcomes.stopped).toBe(0);

    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { now: new Date(NOW.getTime() + MINUTE) }),
    );
    expect(second.outcomes.stopped).toBe(1);
    expect(second.outcomes.unrecorded).toBe(0);
    expect(r.texts).toEqual(['stop texting me']);
  }, 30_000);

  it('e: a provider that cannot serve claims nothing and reads nothing', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-e', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-e', ago(20));
    const transport = new FakeTransport();
    const r = reader();
    const abort = { failure: 'billing' as const, detail: 'credit balance', alerted: true };

    const down = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { preflight: async () => ({ proceed: false, abort }) }),
    );
    expect(down.halted).toEqual({ ...abort, skipped: 1, reason: 'provider_down' });
    expect(r.texts).toEqual([]);
    expect((await heldRow('pm-e'))?.readAttempts).toBe(0);

    const up = await recoverHeldOptOutReads(db.database, deps(r.reader, transport));
    expect(up.halted).toBeNull();
    expect(r.texts).toEqual(['stop texting me']);
  }, 30_000);

  it('f: the pass stops starting rows past its budget and names what it left', async () => {
    const a = await parent(PHONE_A);
    for (const [i, body] of ['first text', 'second text', 'third text'].entries()) {
      await inboundRow(a, `pm-f${i}`, body, ago(30 - i));
      await hold(PHONE_A, `pm-f${i}`, ago(30 - i));
    }
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const texts: string[] = [];
    const slow: OptOutReader = {
      read: async (input) => {
        texts.push(input.text);
        offset += OPT_OUT_RECOVERY_BUDGET_MS + 1;
        return { intent: 'none', confirmation: '' };
      },
    };

    const result = await recoverHeldOptOutReads(db.database, deps(slow, new FakeTransport()));

    expect(texts).toEqual(['first text']);
    expect(result.deferred).toBe(2);
    expect(result.outcomes.read_not_stop).toBe(1);
  }, 30_000);

  it('g: a stop with no confirmation revokes, sends nothing, and logs without the text', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-g', 'quiet please forever', ago(20));
    await hold(PHONE_A, 'pm-g', ago(20));
    const transport = new FakeTransport();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(
        reader({ 'quiet please forever': { intent: 'stop', confirmation: '' } }).reader,
        transport,
      ),
    );

    expect(result.outcomes.stopped_confirmation_unsent).toBe(1);
    expect(result.outcomes.stopped).toBe(0);
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(transport.sent).toEqual([]);
    const unsent = errors.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('confirmation not sent')),
    );
    expect(unsent).toHaveLength(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('quiet please forever');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(PHONE_A);
  }, 30_000);

  it('h: a crisis read late gets the crisis reply one-to-one, ledgered, and is released', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-h', FR_CRISIS, ago(20), { chatId: 'chat-group', inGroup: true });
    await hold(PHONE_A, 'pm-h', ago(20));
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();
    const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: writer,
        threadMessage: async (_database, input) => {
          threaded.push(input);
          return { threaded: true, conversationId: 'conv-1' };
        },
      }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
    // The coach reads the thread, not the ledger (body null): the next turn sees the reply.
    expect(threaded).toEqual([
      { familyId: a.familyId, parentUserId: a.parentUserId, body: transport.sent[0]?.body },
    ]);
    // One-to-one, to the number the text came from, never into the family group.
    expect(transport.sent[0]?.to).toBe(PHONE_A);
    expect(Object.keys(transport.sent[0] ?? {}).sort()).toEqual(['body', 'to']);
    expect(crisisReplyViolation('mental', transport.sent[0]?.body ?? '', 'fr')).toBeNull();
    expect(await heldRow('pm-h')).toBeNull();
    expect(posted).toEqual([]);
    expect(await channelRevoked(a.parentUserId)).toBe(false);
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
    const outbound = await db.database
      .select({ providerMessageId: schema.channelMessages.providerMessageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, a.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ providerMessageId: 'fake-out-1' }]);
  }, 30_000);

  it('h: a reply that left is never sent again, even when its ledger write throws', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-h2', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-h2', ago(20));
    const transport = new FakeTransport();
    const { writer } = recordedCrisisWriter();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.channelMessages) throw new Error('ledger down');
            return target.insert(table as typeof schema.auditLog);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const first = await recoverHeldOptOutReads(
      failing,
      deps(r.reader, transport, { saidLine: writer }),
    );
    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    await recoverHeldOptOutReads(
      failing,
      deps(r.reader, transport, { saidLine: writer, now: later }),
    );

    expect(first.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await heldRow('pm-h2')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Error' }),
      'opt-out recovery: late_crisis_ledger_failed',
    );
  }, 30_000);

  it('a late crisis reply to a parent who left the family lands in neither its ledger nor its thread', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-left', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-left', ago(20));
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, a.parentUserId));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: writer,
        threadMessage: threadIfParent,
      }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    // The reply still reaches them, one-to-one.
    expect(transport.sent.map((sent) => sent.to)).toEqual([PHONE_A]);
    expect(await outboundFor(a.parentUserId)).toEqual([]);
    expect(await threadRoles(a.familyId)).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      { trace: 'late_crisis_not_recorded_left_family' },
      'opt-out recovery: late crisis reply sent, not recorded - the author is no longer a parent of that family',
    );
  }, 30_000);

  it('positive control: a current parent gets the late reply in the ledger and the thread', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-stay', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-stay', ago(20));
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: writer,
        threadMessage: threadIfParent,
      }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(await outboundFor(a.parentUserId)).toEqual([{ providerMessageId: 'fake-out-1' }]);
    expect(await threadRoles(a.familyId)).toEqual(['assistant']);
  }, 30_000);

  it('a crisis the router answered live and SENT is released with no second reply', async () => {
    const a = await parent(PHONE_A);
    const channelMessageId = await inboundRow(a, 'pm-live', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-live', ago(20));
    const live = liveLane('written');
    const verdict = await live.lane.consider({
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      channelMessageId,
      text: FR_CRISIS,
      now: ago(19),
      thread: { channel: 'sms', providerChatId: null, inGroup: false },
    });
    expect(verdict).toMatchObject({ status: 'deflected', crisisReply: true });
    expect(live.moments).toEqual(['mental_crisis']);
    // What the router does once the transport accepted that reply (route.ts).
    expect(await noteCrisisReplySent(db.database, 'pm-live', ago(19))).toBe('marked');
    const transport = new FakeTransport();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: recordedCrisisWriter().writer }),
    );

    expect(result.outcomes.crisis_already_answered).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(r.texts).toEqual([]);
    expect(await heldRow('pm-live')).toBeNull();
    expect(posted).toEqual([]);
  }, 30_000);

  it('a live crisis reply whose send failed is answered late once its turn is over', async () => {
    const a = await parent(PHONE_A);
    const channelMessageId = await inboundRow(a, 'pm-unsent', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-unsent', ago(20));
    // The reply was written, and the router's send then threw: nothing confirmed it.
    const verdict = await liveLane('written').lane.consider({
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      channelMessageId,
      text: FR_CRISIS,
      now: ago(19),
      thread: { channel: 'sms', providerChatId: null, inGroup: false },
    });
    expect(verdict.status).toBe('deflected');
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, { saidLine: writer }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_already_answered).toBe(0);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await heldRow('pm-unsent')).toBeNull();
  }, 30_000);

  it('a live crisis reply still leaving keeps its held text, then is answered late if never sent', async () => {
    const a = await parent(PHONE_A);
    const channelMessageId = await inboundRow(a, 'pm-flight', FR_CRISIS, ago(2));
    await hold(PHONE_A, 'pm-flight', ago(2));
    // The turn wrote its reply seconds ago and its send has not come back (it times out).
    await liveLane('written').lane.consider({
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      channelMessageId,
      text: FR_CRISIS,
      now: new Date(NOW.getTime() - 10_000),
      thread: { channel: 'sms', providerChatId: null, inGroup: false },
    });
    const transport = new FakeTransport();
    const { writer } = recordedCrisisWriter();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const first = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: writer }),
    );

    expect(first.outcomes.crisis_reply_in_flight).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(r.texts).toEqual([]);
    expect(await heldRow('pm-flight')).not.toBeNull();

    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: writer, now: later }),
    );

    expect(second.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await heldRow('pm-flight')).toBeNull();
  }, 30_000);

  it('a live send that outlives its turn still holds the held text back', async () => {
    const a = await parent(PHONE_A);
    const channelMessageId = await inboundRow(a, 'pm-slow', FR_CRISIS, ago(3));
    await hold(PHONE_A, 'pm-slow', ago(3));
    // Past the turn deadline, and the deadline does not cancel the send: it may still land.
    await liveLane('written').lane.consider({
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      channelMessageId,
      text: FR_CRISIS,
      now: ago(2),
      thread: { channel: 'sms', providerChatId: null, inGroup: false },
    });
    const transport = new FakeTransport();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: recordedCrisisWriter().writer }),
    );

    expect(result.outcomes.crisis_reply_in_flight).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(r.texts).toEqual([]);
    expect(await heldRow('pm-slow')).not.toBeNull();
  }, 30_000);

  it('a late reply mark left by a tick that died before its send came back is answered, not released', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-dead', FR_CRISIS, ago(40));
    await hold(PHONE_A, 'pm-dead', ago(40));
    // A tick took the mark before its send and was killed: no reply is known to have left.
    await db.database.insert(schema.rateLimits).values({
      route: CRISIS_ANSWERED_ROUTE,
      identifier: createHash('sha256').update('pm-dead').digest('hex').slice(0, 32),
      windowStart: ago(20),
      count: 0,
    });
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, { saidLine: writer }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_already_answered).toBe(0);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
  }, 30_000);

  it('positive control: a crisis the router could not answer still gets its late reply', async () => {
    const a = await parent(PHONE_A);
    const channelMessageId = await inboundRow(a, 'pm-unlive', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-unlive', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const verdict = await liveLane('unwritten').lane.consider({
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      channelMessageId,
      text: FR_CRISIS,
      now: ago(19),
      thread: { channel: 'sms', providerChatId: null, inGroup: false },
    });
    expect(verdict.status).toBe('unwritten');
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, { saidLine: writer }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
  }, 30_000);

  it('a late reply that left is never sent again when releasing its row throws', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-rel', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-rel', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let releases = 0;
    const flaky = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'delete') {
          return (table: unknown) => {
            if (table === schema.optOutHeldMessages) {
              releases += 1;
              if (releases === 1) throw new Error('release lost');
            }
            return target.delete(table as typeof schema.optOutHeldMessages);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;
    const transport = new FakeTransport();
    const { writer } = recordedCrisisWriter();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const first = await recoverHeldOptOutReads(
      flaky,
      deps(r.reader, transport, { saidLine: writer }),
    );
    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    const second = await recoverHeldOptOutReads(
      flaky,
      deps(r.reader, transport, { saidLine: writer, now: later }),
    );

    // Positive control: the fault fired, so the first pass did not finish the row.
    expect(first.outcomes.recovery_failed).toBe(1);
    expect(second.outcomes.crisis_already_answered).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await heldRow('pm-rel')).toBeNull();
  }, 30_000);

  it('a late crisis whose author is not who held the number then is paged holder_changed', async () => {
    const author = await seedFamily(db.database, 'Former Holder Family');
    // The author's channel on the number ended before the text; another person held it then.
    await channel(author, PHONE_A, { verifiedAt: ago(60 * 24 * 7), revokedAt: ago(30) });
    const holder = await seedFamily(db.database, 'Current Holder Family');
    await channel(holder, PHONE_A, { verifiedAt: ago(25), revokedAt: null });
    await inboundRow(author, 'pm-author', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-author', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: recordedCrisisWriter().writer,
      }),
    );

    expect(result.outcomes.crisis_unreachable).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('reason holder_changed.');
  }, 30_000);

  it("a late crisis still reaches the number's own holder when someone typed it in after", async () => {
    await frenchIntake(PHONE_A, 'pm-typed', FR_CRISIS);
    const typist = await seedFamily(db.database, 'Typed Family');
    await channel(typist, PHONE_A, { verifiedAt: null, revokedAt: null, createdAt: ago(10) });
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, { saidLine: writer }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(result.outcomes.crisis_unreachable).toBe(0);
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE_A]);
    expect(posted).toEqual([]);
    expect(await heldRow('pm-typed')).toBeNull();
  }, 30_000);

  it("a ledger text's crisis region is read from its family's postal code", async () => {
    const us = await parent(PHONE_A);
    await db.database
      .update(schema.families)
      .set({ postalCode: '97201' })
      .where(eq(schema.families.id, us.familyId));
    await inboundRow(us, 'pm-us', FR_CRISIS, ago(20));
    const none = await parent(PHONE_B);
    await inboundRow(none, 'pm-noplace', FR_CRISIS, ago(20));
    const row = (id: string, phone: string) => ({
      providerMessageId: id,
      phoneHash: phoneBlindIndex(phone),
      heldAt: ago(20),
      nextReadAt: ago(20),
      readAttempts: 0,
      crisisLanguage: null,
      crisisSituation: null,
      crisisWho: null,
      stopAppliedAt: null,
    });

    expect((await resolveHeldText(db.database, row('pm-us', PHONE_A)))?.region).toBe('US');
    // Positive control: no place stored, no country guessed.
    expect((await resolveHeldText(db.database, row('pm-noplace', PHONE_B)))?.region).toBeNull();
  }, 30_000);

  it('i: a stop from a number already stopped still runs the stop path, quietly', async () => {
    const a = await parent(PHONE_A, { revoked: true });
    const inviter = await parent(PHONE_C);
    await db.database.insert(schema.caregiverInvites).values({
      familyId: inviter.familyId,
      invitedByUserId: inviter.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PHONE_A),
      phoneE164Hash: phoneBlindIndex(PHONE_A),
      state: 'sent',
      expiresAt: new Date(NOW.getTime() + 60 * 24 * MINUTE),
      createdAt: ago(120),
    });
    await inboundRow(a, 'pm-i', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-i', ago(20));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));

    expect(result.outcomes.already_stopped).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-i')).toBeNull();
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.phoneE164Hash, phoneBlindIndex(PHONE_A)));
    expect(invite?.state).toBe('declined');
  }, 30_000);

  it('j: a mid-intake sender is re-read from the open session, and the stop closes it', async () => {
    const session = await createSession(db.database, {
      phoneE164: PHONE_A,
      state: 'awaiting_details',
      sourceCode: null,
    });
    await saveSession(
      db.database,
      session,
      {
        firstTouch: {
          language: 'en',
          place: {
            kind: 'postal',
            areaCoarse: EASTERN_FSA,
            postalCode: null,
            municipality: null,
            city: null,
          },
          locationRequest: null,
        },
        transcript: [
          {
            direction: 'in',
            body: 'stop texting me',
            providerId: 'pm-j',
            at: ago(20).toISOString(),
          },
        ],
        lastProviderId: 'pm-j',
      },
      ago(20),
    );
    await hold(PHONE_A, 'pm-j', ago(20));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));

    expect(result.outcomes.stopped).toBe(1);
    const [row] = await db.database
      .select({ state: schema.smsIntakeSessions.state })
      .from(schema.smsIntakeSessions)
      .where(eq(schema.smsIntakeSessions.id, session.id));
    expect(row?.state).toBe('stopped');
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-j')).toBeNull();
  }, 30_000);

  it('j: the sitting reminder skips a held mid-intake number, and owes it once read', async () => {
    /** Wednesday 21 Oct 2026, 8:00 a.m. EDT, the morning of the session's Eastern postal place. */
    const morning = new Date('2026-10-21T12:00:00.000Z');
    const session = await createSession(db.database, {
      phoneE164: PHONE_B,
      state: 'awaiting_details',
      sourceCode: null,
    });
    await saveSession(
      db.database,
      session,
      {
        firstTouch: {
          language: 'en',
          place: {
            kind: 'postal',
            areaCoarse: 'K2P',
            postalCode: null,
            municipality: null,
            city: null,
          },
          locationRequest: null,
        },
        transcript: [
          {
            direction: 'in',
            body: 'is this the right number',
            providerId: 'pm-j2',
            at: ago(20).toISOString(),
          },
        ],
        lastProviderId: 'pm-j2',
      },
      ago(20),
    );
    await db.database
      .update(schema.smsIntakeSessions)
      .set({ createdAt: ago(20) })
      .where(eq(schema.smsIntakeSessions.id, session.id));
    await hold(PHONE_B, 'pm-j2', ago(20));
    const sitting = new FakeTransport();
    const friendVoice = scriptedFriendVoice;

    const held = await runSittingReminderCron(
      db.database,
      { transport: sitting, friendVoice },
      morning,
    );
    expect(held.optOutHeld).toBe(1);
    expect(sitting.sent).toEqual([]);
    expect((await loadOpenSession(db.database, PHONE_B))?.id).toBe(session.id);
    const [claim] = await db.database
      .select({ at: schema.smsIntakeSessions.sittingReminderSentAt })
      .from(schema.smsIntakeSessions)
      .where(eq(schema.smsIntakeSessions.id, session.id));
    expect(claim?.at).toBeNull();

    const read = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );
    expect(read.outcomes.read_not_stop).toBe(1);

    const owed = await runSittingReminderCron(
      db.database,
      { transport: sitting, friendVoice },
      morning,
    );
    expect(owed.optOutHeld).toBeUndefined();
    expect(owed.sent).toBe(1);
  }, 30_000);

  it('k: a row found in no store is released only when nothing can text the number', async () => {
    await hold(PHONE_A, 'pm-gone', ago(20));
    await hold(PHONE_B, 'pm-fresh', ago(5));
    const r = reader();

    const result = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));

    expect(result.outcomes).toMatchObject({ no_channel: 1, not_yet_recorded: 1 });
    expect(await heldRow('pm-gone')).toBeNull();
    expect(await heldRow('pm-fresh')).not.toBeNull();
    expect(r.texts).toEqual([]);
  }, 30_000);

  it('k: a row found in no store for a number still sendable stays held', async () => {
    await parent(PHONE_A);
    await hold(PHONE_A, 'pm-unrecorded', ago(20));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );

    expect(result.outcomes.unrecorded).toBe(1);
    expect((await heldRow('pm-unrecorded'))?.readAttempts).toBe(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);
  }, 30_000);

  it('k: a provider id two numbers share keeps the second held through later texts and passes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    const b = await parent(PHONE_B, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-shared', 'see you soon', ago(60));
    expect(
      await holdSender(db.database, {
        phoneHash: phoneBlindIndex(PHONE_A),
        providerMessageId: 'pm-shared',
        now: ago(60),
      }),
    ).toBe('held');
    expect(
      await holdSender(db.database, {
        phoneHash: phoneBlindIndex(PHONE_B),
        providerMessageId: 'pm-shared',
        now: ago(60),
      }),
    ).toBe('held_id_collision');
    await inboundRow(b, 'pm-b-later', 'thanks, all good', ago(30));
    const r = reader();

    const first = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, new FakeTransport(), { now: new Date(NOW.getTime() + 2 * 24 * 60 * MINUTE) }),
    );

    // Positive control: the first number's own text is read and released by the same pass.
    expect(first.outcomes.read_not_stop).toBe(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
    // The second number's colliding text can never be placed, so no later text releases it.
    expect(first.outcomes.unrecorded).toBe(1);
    expect(second.outcomes.unrecorded).toBe(1);
    expect(r.texts).toEqual(['see you soon']);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_B))).toBe(true);
  }, 30_000);

  it('l: a legacy hold is re-pointed at every inbound since it was written', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    const heldAt = ago(60);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    await inboundRow(a, 'pm-before', 'an earlier text', new Date(heldAt.getTime() - MINUTE));
    await inboundRow(a, 'pm-l1', 'stop texting me', new Date(heldAt.getTime() + 1000));
    await inboundRow(a, 'pm-l2', 'see you soon', new Date(heldAt.getTime() + 2 * MINUTE));
    await parent(PHONE_B, { place: EASTERN_FSA });
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_B), heldAt });
    const r = reader();

    const result = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));

    expect(result.repointed).toBe(2);
    expect(result.legacyUnpointed).toBe(1);
    expect(result.outcomes).toMatchObject({ stopped: 1, read_not_stop: 1 });
    expect([...r.texts].sort()).toEqual(['see you soon', 'stop texting me']);
    const legacy = await db.database.select().from(schema.optOutReadHolds);
    expect(legacy.map((row) => row.phoneHash)).toEqual([phoneBlindIndex(PHONE_B)]);
    expect(await heldRow('pm-before')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_B))).toBe(true);
  }, 30_000);

  it('l: legacy holds that stay unpointed cannot starve a newer one from its re-point', async () => {
    for (let i = 0; i < HELD_READ_BATCH; i += 1) {
      const phone = `+1555555${String(1000 + i)}`;
      await parent(phone, { place: EASTERN_FSA });
      await db.database
        .insert(schema.optOutReadHolds)
        .values({ phoneHash: phoneBlindIndex(phone), heldAt: ago(600 - i) });
    }
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt: ago(60) });
    await inboundRow(a, 'pm-late-legacy', 'stop texting me', ago(30));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );

    expect(result.legacyUnpointed).toBe(HELD_READ_BATCH);
    expect(result.repointed).toBe(1);
    expect(result.outcomes.stopped).toBe(1);
  }, 30_000);

  it('l: a legacy hold with nothing behind it and no channel left is released', async () => {
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_C), heldAt: ago(60) });

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );

    expect(result.legacyNoChannel).toBe(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_C))).toBe(false);
  }, 30_000);

  it('n: a stop read late from a group message is confirmed one-to-one', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-n', 'stop texting me', ago(20), {
      inGroup: true,
      chatId: 'chat-group-1',
    });
    await hold(PHONE_A, 'pm-n', ago(20));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));

    expect(result.outcomes.stopped).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(PHONE_A);
    expect(JSON.stringify(transport.sent[0])).not.toContain('chat-group-1');
    // The ledger row of the confirmation names no chat, never the family group's, and is
    // never recorded as said to the group.
    const outbound = await db.database
      .select({
        chatId: schema.channelMessages.providerChatId,
        inGroup: schema.channelMessages.inGroup,
      })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, a.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ chatId: null, inGroup: null }]);
  }, 30_000);

  it('n: a held group message is rebuilt as a one-to-one text: no chat, never a group turn', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-n-group', 'stop texting me', ago(20), {
      inGroup: true,
      chatId: 'chat-group-2',
    });
    await hold(PHONE_A, 'pm-n-group', ago(20));
    const row = await heldRow('pm-n-group');
    if (!row) throw new Error('the held row was not written');

    const held = await resolveHeldText(db.database, row);

    expect(held?.inbound).toEqual({
      from: PHONE_A,
      body: 'stop texting me',
      providerId: 'pm-n-group',
      receivedAt: ago(20),
      transport: 'imessage',
    });
  }, 30_000);

  it('n: a stop read late from a one-to-one iMessage keeps its own chat on the ledger', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-n2', 'stop texting me', ago(20), {
      inGroup: false,
      chatId: 'chat-direct-1',
    });
    await hold(PHONE_A, 'pm-n2', ago(20));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );

    expect(result.outcomes.stopped).toBe(1);
    const outbound = await db.database
      .select({ chatId: schema.channelMessages.providerChatId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, a.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ chatId: 'chat-direct-1' }]);
  }, 30_000);

  it('a row another tick claimed first is named claimed_elsewhere and never read', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-taken', 'taken by the other tick', ago(30));
    await inboundRow(a, 'pm-mine', 'read by this tick', ago(20));
    await hold(PHONE_A, 'pm-taken', ago(30));
    await hold(PHONE_A, 'pm-mine', ago(20));
    const r = reader();
    const otherTick = async () => {
      await db.database
        .update(schema.optOutHeldMessages)
        .set({ nextReadAt: new Date(NOW.getTime() + 15 * MINUTE) })
        .where(eq(schema.optOutHeldMessages.providerMessageId, 'pm-taken'));
      return { proceed: true as const, health: null };
    };

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, new FakeTransport(), { preflight: otherTick }),
    );

    expect(result.outcomes.claimed_elsewhere).toBe(1);
    expect(result.outcomes.read_not_stop).toBe(1);
    expect(r.texts).toEqual(['read by this tick']);
    expect((await heldRow('pm-taken'))?.readAttempts).toBe(0);
  }, 30_000);

  it('l: a legacy hold re-points only texts and only those sent while that number was theirs', async () => {
    const u = await parent(PHONE_A, { revoked: true });
    await channel(u, PHONE_C, { verifiedAt: ago(60), revokedAt: null });
    const heldAt = ago(120);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    await inboundRow(u, 'pm-from-a', 'a text from the old number', ago(100));
    await inboundRow(u, 'pm-email', 'an email reply', ago(90), { channel: 'email' });
    await inboundRow(u, 'pm-from-c', 'a text from the new number', ago(30));
    const r = reader();

    const result = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));

    expect(result.repointed).toBe(1);
    expect(r.texts).toEqual(['a text from the old number']);
    expect(await heldRow('pm-email')).toBeNull();
    expect(await heldRow('pm-from-c')).toBeNull();
  }, 30_000);

  it('l: a text from a user who held two numbers at once is never guessed onto one', async () => {
    const u = await parent(PHONE_A);
    // The ledger has no phone column: a second number held at the same moment means
    // this text may have come from either.
    await intake(PHONE_C, [{ providerId: 'pm-other-number', body: 'hello', at: ago(200) }], {
      owner: u,
    });
    const heldAt = ago(120);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    await inboundRow(u, 'pm-which-number', 'stop texting me', ago(100));
    const r = reader();

    const result = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));

    expect(result.repointed).toBe(0);
    expect(result.legacyUnpointed).toBe(1);
    expect(r.texts).toEqual([]);
    expect(await heldRow('pm-which-number')).toBeNull();
    expect(await db.database.select().from(schema.optOutReadHolds)).toHaveLength(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);
  }, 30_000);

  it('l: a stop this number placed is read beside a text that cannot be placed, and only once', async () => {
    const u = await parent(PHONE_A, { place: EASTERN_FSA });
    await intake(PHONE_C, [{ providerId: 'pm-other-number', body: 'hello', at: ago(200) }], {
      owner: u,
    });
    const heldAt = ago(120);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    // Their stop is on this number's own transcript (replayed into the ledger), so it is
    // this number's whatever else they held. The other text could be from either number.
    await intake(
      PHONE_A,
      [{ providerId: 'pm-placed-stop', body: 'stop texting me', at: ago(100) }],
      {
        owner: u,
      },
    );
    await inboundRow(u, 'pm-placed-stop', 'stop texting me', ago(100));
    await inboundRow(u, 'pm-either-number', 'see you soon', ago(90));
    const r = reader();
    const transport = new FakeTransport();

    const first = await recoverHeldOptOutReads(db.database, deps(r.reader, transport));

    expect(first.repointed).toBe(1);
    expect(first.legacyUnpointed).toBe(1);
    expect(first.outcomes.stopped).toBe(1);
    expect(r.texts).toEqual(['stop texting me']);
    expect(await activeChannelOn(u.parentUserId, PHONE_A)).toBe(false);
    expect(transport.sent.map((send) => send.to)).toEqual([PHONE_A]);
    expect(await heldRow('pm-either-number')).toBeNull();
    expect(await db.database.select().from(schema.optOutReadHolds)).toHaveLength(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);

    // The row still stands for the text it could not place, so the next tick must not
    // re-point (and re-read) the stop it already read.
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { now: new Date(NOW.getTime() + MINUTE) }),
    );

    expect(second.repointed).toBe(0);
    expect(second.legacyUnpointed).toBe(1);
    expect(Object.values(second.outcomes).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(r.texts).toEqual(['stop texting me']);
    expect(transport.sent).toHaveLength(1);
  }, 30_000);

  it("l: a text on this number's own transcript is placed here, so nothing keeps the row", async () => {
    const u = await parent(PHONE_A);
    await intake(PHONE_C, [{ providerId: 'pm-other-number', body: 'hello', at: ago(200) }], {
      owner: u,
    });
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt: ago(120) });
    await intake(
      PHONE_A,
      [{ providerId: 'pm-own-transcript', body: 'see you soon', at: ago(100) }],
      {
        owner: u,
      },
    );
    await inboundRow(u, 'pm-own-transcript', 'see you soon', ago(100));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );

    expect(result.repointed).toBe(1);
    expect(result.legacyUnpointed).toBe(0);
    expect(result.outcomes.read_not_stop).toBe(1);
    expect(await db.database.select().from(schema.optOutReadHolds)).toEqual([]);
  }, 30_000);

  it('a held text only a closed intake session recorded is still read', async () => {
    const session = await createSession(db.database, {
      phoneE164: PHONE_B,
      state: 'awaiting_details',
      sourceCode: null,
    });
    await saveSession(
      db.database,
      session,
      {
        transcript: [
          {
            direction: 'in',
            body: 'stop texting me',
            providerId: 'pm-closed',
            at: ago(40).toISOString(),
          },
        ],
        state: 'superseded',
        closedAt: ago(30),
      },
      ago(30),
    );
    await hold(PHONE_B, 'pm-closed', ago(40));
    const r = reader();

    const result = await recoverHeldOptOutReads(db.database, deps(r.reader, new FakeTransport()));

    expect(r.texts).toEqual(['stop texting me']);
    expect(result.outcomes.already_stopped).toBe(1);
    expect(result.outcomes.no_channel).toBe(0);
  }, 30_000);

  it('a crisis read late for a sender with no family gets the reply in their language', async () => {
    const sessionId = await frenchIntake(PHONE_C, 'pm-crisis', FR_CRISIS);
    const transport = new FakeTransport();
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, { saidLine: writer }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_replied).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(PHONE_C);
    expect(Object.keys(transport.sent[0] ?? {}).sort()).toEqual(['body', 'to']);
    const body = transport.sent[0]?.body ?? '';
    // The recorded reply names both 988 lines: no place is known, so neither is guessed.
    expect(crisisReplyViolation('mental', body, 'fr')).toBeNull();
    expect(body).toContain('988');
    expect(await heldRow('pm-crisis')).toBeNull();
    expect(posted).toEqual([]);
    // The intake's next turn knows a crisis reply went out.
    const open = await loadOpenSession(db.database, PHONE_C);
    expect(open?.id).toBe(sessionId);
    expect(open?.transcript.map((entry) => [entry.direction, entry.body])).toEqual([
      ['in', FR_CRISIS],
      ['out', body],
    ]);
  }, 30_000);

  it('positive control: the same held text read as none sends nothing', async () => {
    await frenchIntake(PHONE_C, 'pm-none', FR_CRISIS);
    const transport = new FakeTransport();
    const result = await recoverHeldOptOutReads(
      db.database,
      deps(
        reader({ [FR_CRISIS]: { intent: 'none', confirmation: '', language: 'fr' } }).reader,
        transport,
        { saidLine: recordedCrisisWriter().writer },
      ),
    );
    expect(result.outcomes.read_not_stop).toBe(1);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it('a crisis read late with the writer down pages with one reference and keeps the row', async () => {
    await frenchIntake(PHONE_C, 'pm-down', FR_CRISIS);
    const session = await loadOpenSession(db.database, PHONE_C);
    if (!session) throw new Error('no session');
    // The store holds their language, so a later tick need not ask the reader again.
    await saveSession(db.database, session, { ladderLanguage: 'fr' }, ago(19));
    const transport = new FakeTransport();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const first = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: downWriter }),
    );

    expect(first.outcomes.crisis_unanswered).toBe(1);
    expect(transport.sent).toEqual([]);
    const [ref] = await crisisClaimIds();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('where late_read.');
    expect(posted[0]).toContain('reason write_failed.');
    expect(posted[0]).toContain('writes 2.');
    expect(posted[0]).toContain(`ref ${ref}.`);
    // Body-free: neither the number nor the words, which the seeded rows do hold.
    expect(posted[0]).not.toContain('5555550103');
    expect(posted[0]).not.toContain(FR_CRISIS);
    expect(await heldRow('pm-down')).not.toBeNull();
    expect(r.texts).toEqual([FR_CRISIS]);

    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: downWriter, now: later }),
    );

    expect(second.outcomes.crisis_unanswered).toBe(1);
    expect(posted).toHaveLength(1);
    expect(await heldRow('pm-down')).not.toBeNull();
    // A recorded crisis is never handed to the model to read again.
    expect(r.texts).toEqual([FR_CRISIS]);
  }, 30_000);

  it('a recorded crisis is read once: later ticks reply in the language read then', async () => {
    await frenchIntake(PHONE_C, 'pm-again', FR_CRISIS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();
    let calls = 0;
    const flipping: OptOutReader = {
      read: async () => {
        calls += 1;
        return calls === 1 ? FR_MENTAL : { intent: 'none', confirmation: '', language: 'en' };
      },
    };
    // The real writer, provider down, watched for the language it is asked to write in.
    const languages: Array<string | null> = [];
    const watched: SaidLineWriter = {
      write: async (input) => {
        languages.push(input.language);
        return downWriter.write(input);
      },
    };
    const outcomes = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const now = new Date(NOW.getTime() + tick * (heldReadBackoff(tick) + MINUTE));
      const result = await recoverHeldOptOutReads(
        db.database,
        deps(flipping, transport, { saidLine: watched, now }),
      );
      outcomes.push(result.outcomes.crisis_unanswered);
    }

    // No language in the store, and still the text is never read again.
    expect(calls).toBe(1);
    expect(outcomes).toEqual([1, 1, 1]);
    expect(languages).toEqual(['fr', 'fr', 'fr', 'fr', 'fr', 'fr']);
    expect(await heldRow('pm-again')).not.toBeNull();
    expect(posted).toHaveLength(1);
  }, 30_000);

  it('a recorded emergency is retried from the same facts it was first read with', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-choke', 'help he is choking', ago(20));
    await hold(PHONE_A, 'pm-choke', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const emergency: OptOutReading = {
      intent: 'crisis_emergency',
      confirmation: '',
      language: 'en',
      situation: 'choking',
      who: 'child',
    };
    const r = reader({ 'help he is choking': emergency });
    // The real writer, provider down, watched for the facts it is asked to write from.
    const inputs: unknown[] = [];
    const watched: SaidLineWriter = {
      write: async (input) => {
        inputs.push(input);
        return downWriter.write(input);
      },
    };
    const transport = new FakeTransport();

    await recoverHeldOptOutReads(db.database, deps(r.reader, transport, { saidLine: watched }));
    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    const second = await recoverHeldOptOutReads(
      db.database,
      deps(r.reader, transport, { saidLine: watched, now: later }),
    );

    expect(r.texts).toEqual(['help he is choking']);
    expect(second.outcomes.crisis_unanswered).toBe(1);
    // Two writes a tick (the draft and its re-ask): the retry is asked exactly as the first.
    expect(inputs).toHaveLength(4);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(inputs[3]).toEqual(inputs[1]);
    // Positive control: the first read's situation reached the writer at all.
    expect(JSON.stringify(inputs[0])).toContain('chok');
  }, 30_000);

  const OVERDOSE: OptOutReading = {
    intent: 'crisis_emergency',
    confirmation: '',
    language: 'en',
    situation: 'poisoning_or_overdose',
    who: 'child',
  };
  const OVERDOSE_TEXT = 'she swallowed the pills';

  it('an erased family takes what its crisis was read as: no row still names it', async () => {
    // The parent also sits in a second family on the same number, so the held row stays.
    const erased = await seedFamily(db.database, 'First Family');
    const kept = await seedFamily(db.database, 'Second Family');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: kept.familyId, userId: erased.parentUserId, role: 'co_parent' });
    await channel({ familyId: kept.familyId, parentUserId: erased.parentUserId }, PHONE_A, {
      verifiedAt: ago(7 * 24 * 60),
      revokedAt: null,
    });
    await inboundRow(erased, 'pm-od', OVERDOSE_TEXT, ago(20));
    await hold(PHONE_A, 'pm-od', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const read = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [OVERDOSE_TEXT]: OVERDOSE }).reader, new FakeTransport(), {
        saidLine: downWriter,
      }),
    );
    expect(read.outcomes.crisis_unanswered).toBe(1);
    // Positive control: while the text is held for its retry, its facts are kept somewhere.
    expect(await rowsNaming('poisoning_or_overdose')).not.toEqual([]);

    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: ago(1) })
      .where(eq(schema.families.id, erased.familyId));
    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(await heldRow('pm-od')).not.toBeNull();
    expect(await crisisClaimIds()).toHaveLength(1);
    expect(await rowsNaming('poisoning_or_overdose')).toEqual([]);
  }, 30_000);

  it('a held crisis row released takes what it was read as with it', async () => {
    const a = await pendingParent(PHONE_B);
    await inboundRow(a, 'pm-od-ns', OVERDOSE_TEXT, ago(20));
    await hold(PHONE_B, 'pm-od-ns', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [OVERDOSE_TEXT]: OVERDOSE }).reader, new FakeTransport(), {
        saidLine: downWriter,
      }),
    );

    expect(result.outcomes.crisis_unreachable).toBe(1);
    expect(await heldRow('pm-od-ns')).toBeNull();
    // The page's claim stays for its lookback, and names only kind, where and why.
    expect(await crisisClaimIds()).toHaveLength(1);
    expect(await rowsNaming('poisoning_or_overdose')).toEqual([]);
    expect(await rowsNaming(':child')).toEqual([]);
  }, 30_000);

  it('a crisis read late from a number that changed hands is paged, not answered', async () => {
    const sessionId = await frenchIntake(PHONE_C, 'pm-moved', FR_CRISIS);
    await db.database
      .update(schema.smsIntakeSessions)
      .set({ closedAt: ago(10), state: 'superseded' })
      .where(eq(schema.smsIntakeSessions.id, sessionId));
    const other = await seedFamily(db.database, 'New Holder Family');
    await channel(other, PHONE_C, { verifiedAt: ago(5), revokedAt: null });
    const transport = new FakeTransport();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: recordedCrisisWriter().writer,
      }),
    );

    expect(result.outcomes.crisis_unreachable).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('reason holder_changed.');
    expect(posted[0]).toContain('where late_read.');
    expect(await heldRow('pm-moved')).toBeNull();
  }, 30_000);

  it('a late crisis reply whose send throws pages send_failed and keeps the row', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-st', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-st', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class FailingTransport extends FakeTransport {
      override async send(): Promise<{ providerMessageId: string }> {
        throw new Error('carrier timed out');
      }
    }
    const { writer, misses } = recordedCrisisWriter();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, new FailingTransport(), {
        saidLine: writer,
      }),
    );

    expect(misses).toEqual([]);
    expect(result.outcomes.crisis_unanswered).toBe(1);
    expect(result.outcomes.crisis_replied).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('reason send_failed.');
    expect(posted[0]).toContain('where late_read.');
    expect(await heldRow('pm-st')).not.toBeNull();
  }, 30_000);

  it('a failed late send never takes off the sent mark a live reply put on meanwhile', async () => {
    const a = await parent(PHONE_A);
    // Due first, so the first send out is this text's.
    await inboundRow(a, 'pm-both', FR_CRISIS, ago(21));
    await hold(PHONE_A, 'pm-both', ago(21));
    await inboundRow(a, 'pm-late-only', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-late-only', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The live turn's send of pm-both lands while the late one is out; then the late one fails.
    let sends = 0;
    class LiveLandsMeanwhile extends FakeTransport {
      override async send(): Promise<{ providerMessageId: string }> {
        sends += 1;
        if (sends === 1) await noteCrisisReplySent(db.database, 'pm-both', NOW);
        throw new Error('carrier timed out');
      }
    }
    const { writer, misses } = recordedCrisisWriter();

    const first = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, new LiveLandsMeanwhile(), {
        saidLine: writer,
      }),
    );

    expect(misses).toEqual([]);
    expect(sends).toBe(2);

    expect(first.outcomes.crisis_unanswered).toBe(2);
    expect(await crisisReplyState(db.database, 'pm-both', NOW)).toBe('answered');
    // Positive control: with no live reply, the failed send's own mark does come off.
    expect(await crisisReplyState(db.database, 'pm-late-only', NOW)).toBe('unanswered');
  }, 30_000);

  it('a late reply whose parent check throws still writes the read row, once', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-pc', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-pc', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: Parameters<Database['select']>) => {
          const builder = target.select(...args);
          return new Proxy(builder, {
            get(b, p, r) {
              if (p !== 'from') return Reflect.get(b, p, r);
              return (table: unknown) => {
                if (table === schema.familyMembers) throw new Error('members down');
                return b.from(table as typeof schema.familyMembers);
              };
            },
          });
        };
      },
    }) as Database;
    const transport = new FakeTransport();
    const { writer } = recordedCrisisWriter();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });

    const first = await recoverHeldOptOutReads(
      failing,
      deps(r.reader, transport, { saidLine: writer }),
    );
    const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
    await recoverHeldOptOutReads(
      failing,
      deps(r.reader, transport, { saidLine: writer, now: later }),
    );

    expect(first.outcomes.crisis_replied).toBe(1);
    expect(first.outcomes.recovery_failed).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
    expect(await heldRow('pm-pc')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      { err: 'Error' },
      'opt-out recovery: late_crisis_parent_check_failed',
    );
  }, 30_000);

  /** A parent whose only channel on the number was asked for and never verified. */
  async function pendingParent(phone: string): Promise<{ familyId: string; parentUserId: string }> {
    const seeded = await seedFamily(db.database, 'Pending Family');
    await channel(seeded, phone, { verifiedAt: null, revokedAt: null, createdAt: ago(60 * 24) });
    return seeded;
  }

  it('a crisis read late from a number that cannot be texted is paged not_sendable, sending nothing', async () => {
    const a = await pendingParent(PHONE_B);
    await inboundRow(a, 'pm-ns', FR_CRISIS, ago(20));
    await hold(PHONE_B, 'pm-ns', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: recordedCrisisWriter().writer,
      }),
    );

    expect(result.outcomes.crisis_unreachable).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('reason not_sendable.');
    expect(await heldRow('pm-ns')).toBeNull();
  }, 30_000);

  it('an unreachable late crisis whose page did not leave keeps the row', async () => {
    const a = await pendingParent(PHONE_B);
    await inboundRow(a, 'pm-pf', FR_CRISIS, ago(20));
    await hold(PHONE_B, 'pm-pf', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, transport, {
        saidLine: recordedCrisisWriter().writer,
        crisisPager: failurePageCrisisPager(db.database, {
          now: NOW,
          post: async () => 'failed',
        }),
      }),
    );

    expect(result.outcomes.crisis_unanswered).toBe(1);
    expect(result.outcomes.crisis_unreachable).toBe(0);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-pf')).not.toBeNull();
  }, 30_000);

  it('a late crisis reply that left is never sent again when the read audit row throws', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-au', FR_CRISIS, ago(20));
    await hold(PHONE_A, 'pm-au', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();
    const { writer } = recordedCrisisWriter();
    const r = reader({ [FR_CRISIS]: FR_MENTAL });
    // A real database fault on the read's audit row, after the reply has left.
    await db.exec(`
      create function refuse_hold_read_audit() returns trigger language plpgsql
        as $$ begin
          if new.action_taken = 'opt_out_hold_read' then raise exception 'refused for the test'; end if;
          return new;
        end $$;
      create trigger refuse_hold_read_audit before insert on audit_log
        for each row execute function refuse_hold_read_audit();
    `);
    let first: Awaited<ReturnType<typeof recoverHeldOptOutReads>>;
    try {
      first = await recoverHeldOptOutReads(
        db.database,
        deps(r.reader, transport, { saidLine: writer }),
      );
      const later = new Date(NOW.getTime() + heldReadBackoff(1) + MINUTE);
      await recoverHeldOptOutReads(
        db.database,
        deps(r.reader, transport, { saidLine: writer, now: later }),
      );
    } finally {
      await db.exec(
        'drop trigger refuse_hold_read_audit on audit_log; drop function refuse_hold_read_audit();',
      );
    }

    // Positive control: the fault fired, so the first pass did not finish the row.
    expect(first.outcomes.recovery_failed).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(await heldRow('pm-au')).toBeNull();
  }, 30_000);

  it('names every outcome, zero by default, when nothing is held', async () => {
    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );
    expect(result).toEqual({
      repointed: 0,
      legacyNoChannel: 0,
      legacyUnpointed: 0,
      legacyFailed: 0,
      outcomes: {
        stopped: 0,
        stopped_confirmation_unsent: 0,
        stopped_confirmation_failed: 0,
        stopped_confirmation_waiting: 0,
        stopped_confirmation_dropped: 0,
        stop_superseded: 0,
        stop_failed: 0,
        already_stopped: 0,
        read_not_stop: 0,
        read_start: 0,
        read_identity: 0,
        crisis_replied: 0,
        crisis_unanswered: 0,
        crisis_unreachable: 0,
        crisis_already_answered: 0,
        crisis_reply_in_flight: 0,
        read_leave_group: 0,
        read_failed: 0,
        not_yet_recorded: 0,
        unrecorded: 0,
        timeline_unresolved: 0,
        recovery_failed: 0,
        no_channel: 0,
        claimed_elsewhere: 0,
      },
      deferred: 0,
      halted: null,
    });
  }, 30_000);

  it('backs off from fifteen minutes, doubling, to a day', () => {
    expect(heldReadBackoff(1)).toBe(15 * MINUTE);
    expect(heldReadBackoff(2)).toBe(30 * MINUTE);
    expect(heldReadBackoff(4)).toBe(120 * MINUTE);
    expect(heldReadBackoff(7)).toBe(16 * 60 * MINUTE);
    expect(heldReadBackoff(8)).toBe(24 * 60 * MINUTE);
    expect(heldReadBackoff(40)).toBe(24 * 60 * MINUTE);
  });
});

describe('a late stop belongs to the holder of its number at the time (latest row wins)', () => {
  const DAY = 24 * 60;
  const recover = (transport: FakeTransport, r: OptOutReader = reader().reader) =>
    recoverHeldOptOutReads(db.database, deps(r, transport));

  it('(1) a closed pre-family stop is superseded once the number is verified to a new user', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-t1', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-t1', ago(40));
    const bob = await parent(PHONE_A, { verifiedAt: ago(20) });
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(result.outcomes.stopped + result.outcomes.already_stopped).toBe(0);
    expect(await channelRevoked(bob.parentUserId)).toBe(false);
    expect(await withdrawals()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-t1')).toBeNull();
  }, 30_000);

  it('(2) the same stop, with that session still the current holder, applies and closes it', async () => {
    const id = await intake(
      PHONE_A,
      [{ providerId: 'pm-t2', body: 'stop texting me', at: ago(40) }],
      { place: EASTERN_FSA },
    );
    await hold(PHONE_A, 'pm-t2', ago(40));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(await sessionRow(id)).toMatchObject({ state: 'stopped', closedAt: NOW });
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-t2')).toBeNull();
  }, 30_000);

  it('(3) a stop in a closed session is superseded by a newer open one, which is left alone', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-t3', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    const newer = await intake(PHONE_A, [
      { providerId: 'pm-t3-new', body: 'hi, who is this', at: ago(10) },
    ]);
    await hold(PHONE_A, 'pm-t3', ago(40));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(await sessionRow(newer)).toEqual({ state: 'awaiting_details', closedAt: null });
    expect(await heldRow('pm-t3')).toBeNull();
  }, 30_000);

  it('(4) an unverified channel created after the stop neither supersedes it nor holds the number', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-t4', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-t4', ago(40));
    // A number typed into a sign-up form proves nothing about who holds it.
    const vera = await seedFamily(db.database, 'Pending Family');
    await channel(vera, PHONE_A, { verifiedAt: null, revokedAt: null, createdAt: ago(20) });
    const transport = new FakeTransport();

    const result = await recover(transport);

    // Nobody holds the number now, so the stop applies quietly and the row is released.
    expect(result.outcomes.stop_superseded).toBe(0);
    expect(result.outcomes.timeline_unresolved).toBe(0);
    expect(result.outcomes.already_stopped).toBe(1);
    expect(await heldRow('pm-t4')).toBeNull();
    expect(await activeChannelOn(vera.parentUserId, PHONE_A)).toBe(true);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it("(4) a channel someone else typed in after the stop never keeps it from the number's holder", async () => {
    const id = await intake(
      PHONE_A,
      [{ providerId: 'pm-t4b', body: 'stop texting me', at: ago(40) }],
      { place: EASTERN_FSA },
    );
    await hold(PHONE_A, 'pm-t4b', ago(40));
    const typist = await seedFamily(db.database, 'Typed Family');
    await channel(typist, PHONE_A, { verifiedAt: null, revokedAt: null, createdAt: ago(20) });
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.timeline_unresolved).toBe(0);
    expect(result.outcomes.stopped).toBe(1);
    expect(await sessionRow(id)).toMatchObject({ state: 'stopped', closedAt: NOW });
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-t4b')).toBeNull();
    // The typed-in channel is nobody's holding yet: the stop never reaches it.
    expect(await activeChannelOn(typist.parentUserId, PHONE_A)).toBe(true);
  }, 30_000);

  it('(4) positive control: the holder verifying the number again after the stop supersedes it', async () => {
    const holder = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(holder, 'pm-t4c', 'please stop texting me', ago(40));
    await hold(PHONE_A, 'pm-t4c', ago(40));
    // A fresh consent grant revokes the old row and inserts a new one, never an un-revoke.
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: ago(20) })
      .where(eq(schema.parentChannels.userId, holder.parentUserId));
    await channel(holder, PHONE_A, { verifiedAt: ago(20), revokedAt: null, createdAt: ago(20) });
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(result.outcomes.stopped).toBe(0);
    expect(await withdrawals()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-t4c')).toBeNull();
  }, 30_000);

  it('(5) a stop from a number its author left never revokes the number they moved to', async () => {
    const alice = await parent(PHONE_A, { revoked: true });
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: ago(50) })
      .where(eq(schema.parentChannels.userId, alice.parentUserId));
    await channel(alice, PHONE_C, { verifiedAt: ago(50), revokedAt: null });
    const bob = await parent(PHONE_A, { verifiedAt: ago(40) });
    await inboundRow(alice, 'pm-moved', 'stop texting me', ago(70));
    await hold(PHONE_A, 'pm-moved', ago(70));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(await activeChannelOn(alice.parentUserId, PHONE_C)).toBe(true);
    expect(await channelRevoked(bob.parentUserId)).toBe(false);
    expect(await withdrawals()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-moved')).toBeNull();
  }, 30_000);

  it('(5) a stop from a session left open on the old number revokes nothing on the new one', async () => {
    const alice = await parent(PHONE_A, { revoked: true, place: EASTERN_FSA });
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: ago(50) })
      .where(eq(schema.parentChannels.userId, alice.parentUserId));
    await channel(alice, PHONE_C, { verifiedAt: ago(50), revokedAt: null });
    const id = await intake(
      PHONE_A,
      [{ providerId: 'pm-ladder', body: 'stop texting me', at: ago(30) }],
      { createdAt: ago(8 * DAY), owner: alice },
    );
    await hold(PHONE_A, 'pm-ladder', ago(30));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(await activeChannelOn(alice.parentUserId, PHONE_C)).toBe(true);
    expect(await withdrawals()).toEqual([]);
    expect(await sessionRow(id)).toMatchObject({ state: 'stopped' });
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE_A]);
  }, 30_000);

  it('a late read is told when the stop arrived and when it is read', async () => {
    const u = await parent(PHONE_A);
    await inboundRow(u, 'pm-when', 'stop texting me', ago(330));
    await hold(PHONE_A, 'pm-when', ago(330));
    const inputs: OptOutReadInput[] = [];
    const seen: OptOutReader = {
      read: async (input) => {
        inputs.push(input);
        return scriptedOptOutRead(input.text);
      },
    };

    await recover(new FakeTransport(), seen);

    expect(inputs.map((input) => input.late)).toEqual([{ receivedAt: ago(330), readAt: NOW }]);
  }, 30_000);

  it('(6) the holder at the time, still current, is stopped, confirmed and released', async () => {
    const before = await seedFamily(db.database, 'Earlier Family');
    await channel(before, PHONE_A, { verifiedAt: ago(7 * DAY), revokedAt: ago(3 * DAY) });
    const u = await parent(PHONE_A, { verifiedAt: ago(2 * DAY), place: EASTERN_FSA });
    await inboundRow(u, 'pm-t6', 'please stop texting me', ago(20));
    await hold(PHONE_A, 'pm-t6', ago(20));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(await channelRevoked(u.parentUserId)).toBe(true);
    expect(await withdrawals()).toEqual([u.parentUserId]);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-t6')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
  }, 30_000);

  it('(7) a timeline that cannot say whose stop it is keeps the hold and pages', async () => {
    const u = await seedFamily(db.database, 'Ledger Family');
    await channel(u, PHONE_A, { verifiedAt: ago(7 * DAY), revokedAt: ago(60) });
    const v = await parent(PHONE_A, { verifiedAt: ago(60) });
    // The ledger names u for a text sent while the timeline says v held the number.
    await inboundRow(u, 'pm-t7', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-t7', ago(20));
    const transport = new FakeTransport();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recover(transport);

    expect(result.outcomes.timeline_unresolved).toBe(1);
    expect((await heldRow('pm-t7'))?.readAttempts).toBe(1);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);
    expect(await channelRevoked(v.parentUserId)).toBe(false);
    expect(await withdrawals()).toEqual([]);
    expect(transport.sent).toEqual([]);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain('timeline_unresolved');
    for (const id of ['pm-t7', u.parentUserId, v.parentUserId, phoneBlindIndex(PHONE_A)]) {
      expect(logged).not.toContain(id);
    }
    const texts: string[] = [];
    await pageFailureAlerts(db.database, {
      now: NOW,
      post: async (text) => {
        texts.push(text);
        return 'sent';
      },
    });
    expect(texts.find((text) => text.startsWith('Hale: opt-out reads held.'))).toContain(
      'messages 1.',
    );
  }, 30_000);

  it('l: a legacy stop replayed into the ledger at provisioning is re-pointed and read', async () => {
    const heldAt = ago(60);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    const sentAt = new Date(heldAt.getTime() + 1000);
    const u = await seedFamily(db.database, 'Provisioned Family');
    await intake(PHONE_A, [{ providerId: 'pm-replayed', body: 'stop texting me', at: sentAt }], {
      closedAt: ago(55),
      owner: u,
    });
    await channel(u, PHONE_A, { verifiedAt: ago(55), revokedAt: null });
    await inboundRow(u, 'pm-replayed', 'stop texting me', sentAt);
    const r = reader();
    const transport = new FakeTransport();

    const result = await recover(transport, r.reader);

    expect(result.repointed).toBe(1);
    expect(result.legacyUnpointed).toBe(0);
    expect(r.texts).toEqual(['stop texting me']);
    // Provisioning after the stop is the newer consent: the stop is read and superseded.
    expect(result.outcomes.stop_superseded).toBe(1);
    expect(await channelRevoked(u.parentUserId)).toBe(false);
    expect(transport.sent).toEqual([]);
    expect(await db.database.select().from(schema.optOutReadHolds)).toEqual([]);
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
  }, 30_000);

  it('l: a legacy hold finds a stop only a closed pre-family session still holds', async () => {
    const heldAt = ago(60);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_B), heldAt });
    await intake(
      PHONE_B,
      [{ providerId: 'pm-closed-legacy', body: 'stop texting me', at: ago(50) }],
      { closedAt: ago(45) },
    );
    const r = reader();

    const result = await recover(new FakeTransport(), r.reader);

    expect(result.repointed).toBe(1);
    expect(r.texts).toEqual(['stop texting me']);
    expect(result.outcomes.already_stopped).toBe(1);
  }, 30_000);

  it('a stop path that fails before the number stops being sendable keeps the hold', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-sf', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-sf', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A real database fault on the revoke, not a mock of the stop path.
    await db.exec(`
      create function refuse_channel_update() returns trigger language plpgsql
        as $$ begin raise exception 'refused for the test'; end $$;
      create trigger refuse_channel_update before update on parent_channels
        for each row execute function refuse_channel_update();
    `);
    const transport = new FakeTransport();
    let result: Awaited<ReturnType<typeof recover>>;
    try {
      result = await recover(transport);
    } finally {
      await db.exec(
        'drop trigger refuse_channel_update on parent_channels; drop function refuse_channel_update();',
      );
    }

    expect(result.outcomes.stop_failed).toBe(1);
    expect(await heldRow('pm-sf')).not.toBeNull();
    expect(await channelRevoked(a.parentUserId)).toBe(false);
    expect(transport.sent).toEqual([]);
    // Positive control: with the fault gone, the next due read stops the number.
    const later = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, transport, { now: new Date(NOW.getTime() + 16 * MINUTE) }),
    );
    expect(later.outcomes.stopped).toBe(1);
    expect(await heldRow('pm-sf')).toBeNull();
  }, 30_000);

  it('a stop whose confirmation send fails after the revoke keeps the hold', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-cf', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-cf', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class FailingTransport extends FakeTransport {
      override async send(): Promise<{ providerMessageId: string }> {
        throw new Error('carrier timed out');
      }
    }

    const result = await recover(new FailingTransport());

    expect(result.outcomes.stopped_confirmation_failed).toBe(1);
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(await heldRow('pm-cf')).not.toBeNull();
  }, 30_000);

  it('a late confirmation from an intake transcript never carries its chat', async () => {
    const u = await parent(PHONE_A, { place: EASTERN_FSA });
    await intake(
      PHONE_A,
      [
        {
          providerId: 'pm-im',
          body: 'stop texting me',
          at: ago(20),
          channel: 'imessage',
          chatId: 'chat-intake-1',
        },
      ],
      { createdAt: ago(8 * DAY), owner: u },
    );
    await hold(PHONE_A, 'pm-im', ago(20));

    const result = await recover(new FakeTransport());

    expect(result.outcomes.stopped).toBe(1);
    const outbound = await db.database
      .select({ chatId: schema.channelMessages.providerChatId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, u.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ chatId: null }]);
  }, 30_000);

  it("the read row is about one adult: in that parent's own copy only, never the household trail", async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    const [co] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:co-parent-held', name: 'Robin' })
      .returning({ id: schema.users.id });
    const coParent = co?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: a.familyId, userId: coParent, role: 'co_parent' });
    await inboundRow(a, 'pm-x', 'please stop texting me', ago(20));
    await hold(PHONE_A, 'pm-x', ago(20));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader().reader, new FakeTransport()),
    );
    expect(result.outcomes.stopped).toBe(1);

    // Positive control: the row is written, about the parent who texted, with no outcome.
    const [row] = await db.database
      .select({ id: schema.auditLog.id, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'opt_out_hold_read'));
    expect(row?.after).toBeNull();
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);

    // Positive control: the same stop's revoke is a family-visible row, and it shows.
    const [revoked] = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'channel_sms_revoked'));
    expect(revoked?.id).toEqual(expect.any(String));

    // A crisis no reply reached, about the same parent, as the crisis pager records it.
    const [crisis] = await db.database
      .insert(schema.auditLog)
      .values({
        familyId: a.familyId,
        actor: 'system',
        actionTaken: 'crisis_unanswered',
        targetTable: 'users',
        targetId: a.parentUserId,
        after: { kind: 'mental', where: 'late_read', reason: 'send_failed', writes: 1 },
      })
      .returning({ id: schema.auditLog.id });

    const trail = await loadTrailForFamily(db.database, a.familyId, NO_TEEN_UNLOCKS);
    expect(trail.map((entry) => entry.id)).toContain(revoked?.id);
    expect(trail.map((entry) => entry.id)).not.toContain(row?.id);
    expect(trail.map((entry) => entry.id)).not.toContain(crisis?.id);
    // Right of access: the parent the rows are about gets them in their own copy.
    const own = await assembleFamilyExport(db.database, a.familyId, {
      actorUserId: a.parentUserId,
      now: NOW,
    });
    expect(own.trail.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([revoked?.id, row?.id, crisis?.id]),
    );
    // Every other adult's copy still leaves them out, and still holds the family's rows.
    const other = await assembleFamilyExport(db.database, a.familyId, {
      actorUserId: coParent,
      now: NOW,
    });
    expect(other.trail.map((entry) => entry.id)).toContain(revoked?.id);
    expect(other.trail.map((entry) => entry.id)).not.toContain(row?.id);
    expect(other.trail.map((entry) => entry.id)).not.toContain(crisis?.id);
  }, 30_000);

  it("a group-thread crisis from co-parent B is about B: never in parent A's copy", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    const [co] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:co-parent-group', name: 'Robin' })
      .returning({ id: schema.users.id });
    const b = { familyId: a.familyId, parentUserId: co?.id as string };
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: a.familyId, userId: b.parentUserId, role: 'co_parent' });
    await channel(b, PHONE_B, { verifiedAt: ago(7 * 24 * 60), revokedAt: null });
    // The group door attributes a text to the owner of the number that sent it.
    const sender = await resolveVerifiedChannelByPhone(db.database, PHONE_B);
    expect(sender).toMatchObject({ familyId: a.familyId, userId: b.parentUserId });
    await inboundRow(
      { familyId: a.familyId, parentUserId: sender?.userId as string },
      'pm-group-crisis',
      FR_CRISIS,
      ago(20),
      { chatId: 'chat-family-group', inGroup: true },
    );
    await hold(PHONE_B, 'pm-group-crisis', ago(20));

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(reader({ [FR_CRISIS]: FR_MENTAL }).reader, new FakeTransport(), {
        saidLine: downWriter,
      }),
    );

    expect(result.outcomes.crisis_unanswered).toBe(1);
    const crises = await db.database
      .select({ id: schema.auditLog.id, targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'crisis_unanswered'));
    expect(crises).toEqual([{ id: expect.any(String), targetId: b.parentUserId }]);
    const crisisId = crises[0]?.id;
    const copyA = await assembleFamilyExport(db.database, a.familyId, {
      actorUserId: a.parentUserId,
      now: NOW,
    });
    expect(copyA.trail.map((entry) => entry.id)).not.toContain(crisisId);
    // Positive control: the adult who texted gets it in their own copy.
    const copyB = await assembleFamilyExport(db.database, a.familyId, {
      actorUserId: b.parentUserId,
      now: NOW,
    });
    expect(copyB.trail.map((entry) => entry.id)).toContain(crisisId);
  }, 30_000);

  it('an erased family takes its held reads with it, never a number someone still holds', async () => {
    const a = await parent(PHONE_A);
    await channel(a, PHONE_C, { verifiedAt: ago(7 * DAY), revokedAt: ago(2 * DAY) });
    await parent(PHONE_C, { verifiedAt: ago(DAY) });
    await parent(PHONE_B);
    await hold(PHONE_A, 'pm-erase', ago(20));
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt: ago(60) });
    await hold(PHONE_B, 'pm-keep', ago(20));
    // The erased family's old number, now another parent's: their unread stop may be here,
    // while a text the erased family sent from it goes with the family.
    await hold(PHONE_C, 'pm-held-by-new-holder', ago(20));
    await inboundRow(a, 'pm-erased-on-old-number', 'an old text', ago(3 * DAY));
    await hold(PHONE_C, 'pm-erased-on-old-number', ago(3 * DAY));
    // Positive control: a text the family sent, held on a number that was never one of its
    // channels and that nobody holds now, goes with the family.
    const other = await parent(PHONE_D, { revoked: true });
    await inboundRow(a, 'pm-erased-off-number', 'a text from elsewhere', ago(DAY));
    await hold(PHONE_D, 'pm-erased-off-number', ago(DAY));
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: ago(1) })
      .where(eq(schema.families.id, a.familyId));

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(await heldRow('pm-erase')).toBeNull();
    expect(await db.database.select().from(schema.optOutReadHolds)).toEqual([]);
    expect(await heldRow('pm-keep')).not.toBeNull();
    expect(await heldRow('pm-held-by-new-holder')).not.toBeNull();
    // Someone holds that number now, so no row on it goes: the row carries no family
    // content, and the hold stays fail closed.
    expect(await heldRow('pm-erased-on-old-number')).not.toBeNull();
    expect(await heldRow('pm-erased-off-number')).toBeNull();
    expect(await activeChannelOn(other.parentUserId, PHONE_D)).toBe(false);
  }, 30_000);

  it('erasing one of two families a parent sits in never takes their unread stop', async () => {
    const famA = await parent(PHONE_B);
    const famB = await seedFamily(db.database, 'Second Family');
    const both = await seedFamily(db.database, 'First Family');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: famB.familyId, userId: both.parentUserId, role: 'co_parent' });
    await channel({ familyId: famB.familyId, parentUserId: both.parentUserId }, PHONE_A, {
      verifiedAt: ago(7 * DAY),
      revokedAt: null,
    });
    // Their stop, ledgered under the family being erased.
    await inboundRow(both, 'pm-two-families', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-two-families', ago(20));
    // Positive control: a number nobody holds after the erasure loses its row.
    await inboundRow(famA, 'pm-nobody-left', 'stop texting me', ago(20));
    await hold(PHONE_B, 'pm-nobody-left', ago(20));
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: ago(1) })
      .where(inArray(schema.families.id, [both.familyId, famA.familyId]));

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(2);
    expect(await activeChannelOn(both.parentUserId, PHONE_A)).toBe(true);
    expect(await heldRow('pm-two-families')).not.toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(true);
    expect(await heldRow('pm-nobody-left')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_B))).toBe(false);
  }, 30_000);
});

describe('a late stop reaches every record on the number, only its owner supersedes it, and one bad row never stops the pass', () => {
  const DAY = 24 * 60;
  const recover = (transport: FakeTransport, r: OptOutReader = reader().reader) =>
    recoverHeldOptOutReads(db.database, deps(r, transport));

  async function setSessionBlob(id: string, blob: string): Promise<void> {
    await db.database
      .update(schema.smsIntakeSessions)
      .set({ dataEncrypted: blob, phoneEncrypted: blob })
      .where(eq(schema.smsIntakeSessions.id, id));
  }

  async function caregiverInvite(
    by: { familyId: string; parentUserId: string },
    phone: string,
    createdAt: Date,
  ): Promise<string> {
    const [row] = await db.database
      .insert(schema.caregiverInvites)
      .values({
        familyId: by.familyId,
        invitedByUserId: by.parentUserId,
        role: 'co_parent',
        displayName: 'Sam',
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: phoneBlindIndex(phone),
        state: 'awaiting_caregiver_reply',
        expiresAt: new Date(NOW.getTime() + 72 * 60 * MINUTE),
        createdAt,
      })
      .returning({ id: schema.caregiverInvites.id });
    return row?.id as string;
  }

  async function inviteState(id: string): Promise<string | undefined> {
    const [row] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, id));
    return row?.state;
  }

  async function guestReminderOptIn(phone: string, at: Date): Promise<string> {
    const host = await seedFamily(db.database, 'Party Family');
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId: host.familyId, title: 'Birthday party', startsAt: NOW, source: 'parent' })
      .returning({ id: schema.familyEvents.id });
    const [invite] = await db.database
      .insert(schema.partyInvites)
      .values({
        familyId: host.familyId,
        familyEventId: event?.id as string,
        hostUserId: host.parentUserId,
        publicToken: `party-token-${at.getTime()}`,
      })
      .returning({ id: schema.partyInvites.id });
    const [rsvp] = await db.database
      .insert(schema.partyRsvps)
      .values({
        partyInviteId: invite?.id as string,
        displayName: 'Guest',
        nameKey: 'guest',
        response: 'yes',
        reminderOptInAt: at,
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: phoneBlindIndex(phone),
      })
      .returning({ id: schema.partyRsvps.id });
    return rsvp?.id as string;
  }

  async function guestOptedIn(id: string): Promise<boolean> {
    const [row] = await db.database
      .select({ at: schema.partyRsvps.reminderOptInAt })
      .from(schema.partyRsvps)
      .where(eq(schema.partyRsvps.id, id));
    return row?.at != null;
  }

  it("another parent's invite to the number after the stop never supersedes it: the stop applies and declines it", async () => {
    const u = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(u, 'pm-3p-inv', 'stop texting me', ago(40));
    await hold(PHONE_A, 'pm-3p-inv', ago(40));
    const inviteId = await caregiverInvite(
      await seedFamily(db.database, 'Inviting'),
      PHONE_A,
      ago(10),
    );
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(result.outcomes.stop_superseded).toBe(0);
    expect(await channelRevoked(u.parentUserId)).toBe(true);
    expect(await resolveSendablePhone(db.database, u.parentUserId)).toBeNull();
    expect(await inviteState(inviteId)).toBe('declined');
    // The stop's own confirmation, and nothing else, ever goes to the number.
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-3p-inv')).toBeNull();
  }, 30_000);

  it('an invite to a number nobody holds, made after the stop, is declined by it', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-inv', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-inv', ago(40));
    const inviteId = await caregiverInvite(
      await seedFamily(db.database, 'Inviting'),
      PHONE_A,
      ago(10),
    );
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.already_stopped).toBe(1);
    expect(result.outcomes.stop_superseded).toBe(0);
    expect(await inviteState(inviteId)).toBe('declined');
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-inv')).toBeNull();
  }, 30_000);

  it('positive control: the owner texting START after the stop supersedes it', async () => {
    const u = await parent(PHONE_A);
    await inboundRow(u, 'pm-then-start', 'stop texting me', ago(40));
    await hold(PHONE_A, 'pm-then-start', ago(40));
    // A live stop read later revoked the channel; then the owner texted START from it.
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: ago(30) })
      .where(eq(schema.parentChannels.userId, u.parentUserId));
    await reenrolOnStart(
      db.database,
      {
        userId: u.parentUserId,
        familyId: u.familyId,
        phoneE164: PHONE_A,
        verbatimReply: 'start again please',
      },
      ago(10),
    );
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(await activeChannelOn(u.parentUserId, PHONE_A)).toBe(true);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-then-start')).toBeNull();
  }, 30_000);

  it('positive control: an invite made before the stop is declined by it', async () => {
    const inviteId = await caregiverInvite(
      await seedFamily(db.database, 'Inviting'),
      PHONE_A,
      ago(60),
    );
    await intake(PHONE_A, [{ providerId: 'pm-inv-old', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-inv-old', ago(40));

    const result = await recover(new FakeTransport());

    expect(result.outcomes.already_stopped).toBe(1);
    expect(await inviteState(inviteId)).toBe('declined');
  }, 30_000);

  it('a guest-reminder opt-in typed in for the number after the stop never supersedes it: withdrawn, stop applies', async () => {
    const u = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(u, 'pm-3p-rsvp', 'stop texting me', ago(40));
    await hold(PHONE_A, 'pm-3p-rsvp', ago(40));
    const rsvpId = await guestReminderOptIn(PHONE_A, ago(10));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(result.outcomes.stop_superseded).toBe(0);
    expect(await channelRevoked(u.parentUserId)).toBe(true);
    expect(await guestOptedIn(rsvpId)).toBe(false);
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE_A]);
    expect(await heldRow('pm-3p-rsvp')).toBeNull();
  }, 30_000);

  it('positive control: a guest-reminder opt-in given before the stop is withdrawn by it', async () => {
    const rsvpId = await guestReminderOptIn(PHONE_A, ago(60));
    await intake(PHONE_A, [{ providerId: 'pm-rsvp-old', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-rsvp-old', ago(40));

    const result = await recover(new FakeTransport());

    expect(result.outcomes.already_stopped).toBe(1);
    expect(await guestOptedIn(rsvpId)).toBe(false);
  }, 30_000);

  it('(d) two people holding the number at the stop: kept, paged, nobody stopped, nothing sent', async () => {
    const x = await parent(PHONE_A);
    const id = await intake(PHONE_A, [
      { providerId: 'pm-two-hi', body: 'hello', at: ago(35) },
      { providerId: 'pm-two', body: 'stop texting me', at: ago(30) },
    ]);
    await hold(PHONE_A, 'pm-two', ago(30));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.timeline_unresolved).toBe(1);
    expect((await heldRow('pm-two'))?.readAttempts).toBe(1);
    expect(await channelRevoked(x.parentUserId)).toBe(false);
    expect(await withdrawals()).toEqual([]);
    expect(await sessionRow(id)).toEqual({ state: 'awaiting_details', closedAt: null });
    expect(transport.sent).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).toContain('timeline_unresolved');
  }, 30_000);

  it('(d) positive control: both holdings are the same person, so the stop applies', async () => {
    const x = await parent(PHONE_A, { place: EASTERN_FSA });
    const id = await intake(
      PHONE_A,
      [
        { providerId: 'pm-one-hi', body: 'hello', at: ago(35) },
        { providerId: 'pm-one', body: 'stop texting me', at: ago(30) },
      ],
      { owner: x },
    );
    await hold(PHONE_A, 'pm-one', ago(30));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(await channelRevoked(x.parentUserId)).toBe(true);
    expect(await sessionRow(id)).toMatchObject({ state: 'stopped', closedAt: NOW });
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE_A]);
  }, 30_000);

  it('a year-old redacted session on the number still holds it and never blocks the read', async () => {
    const u = await parent(PHONE_A, { verifiedAt: ago(400 * DAY), place: EASTERN_FSA });
    const old = await intake(
      PHONE_A,
      [{ providerId: 'pm-old', body: 'hello', at: ago(401 * DAY) }],
      { closedAt: ago(400 * DAY), owner: u },
    );
    await setSessionBlob(old, INTAKE_CONTENT_REDACTED);
    await inboundRow(u, 'pm-red', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-red', ago(20));
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stopped).toBe(1);
    expect(await channelRevoked(u.parentUserId)).toBe(true);
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE_A]);
    expect(await heldRow('pm-red')).toBeNull();
  }, 30_000);

  it('a redacted session holds the number from its creation: a stop before it is superseded', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-before', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    const later = await intake(PHONE_A, [{ providerId: 'pm-after', body: 'hello', at: ago(20) }], {
      closedAt: ago(15),
    });
    await setSessionBlob(later, INTAKE_CONTENT_REDACTED);
    await hold(PHONE_A, 'pm-before', ago(40));

    const result = await recover(new FakeTransport());

    expect(result.outcomes.stop_superseded).toBe(1);
  }, 30_000);

  it('l: a legacy stop whose intake transcript was redacted is re-pointed from the ledger copy', async () => {
    const heldAt = ago(60);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    const sentAt = new Date(heldAt.getTime() + 1000);
    const u = await seedFamily(db.database, 'Provisioned Family');
    const s = await intake(
      PHONE_A,
      [{ providerId: 'pm-red-legacy', body: 'stop texting me', at: sentAt }],
      { closedAt: ago(55), owner: u },
    );
    await setSessionBlob(s, INTAKE_CONTENT_REDACTED);
    await channel(u, PHONE_A, { verifiedAt: ago(55), revokedAt: null });
    await inboundRow(u, 'pm-red-legacy', 'stop texting me', sentAt);
    const r = reader();

    const result = await recover(new FakeTransport(), r.reader);

    expect(result.repointed).toBe(1);
    expect(r.texts).toEqual(['stop texting me']);
    expect(result.outcomes.stop_superseded).toBe(1);
    expect(await db.database.select().from(schema.optOutReadHolds)).toEqual([]);
  }, 30_000);

  it('a row that throws is named and kept, and never stops the rest of the pass', async () => {
    // A blob that decrypts but is not a session: a fault inside one number's rows.
    const corrupt = encryptString('{');
    const legacySession = await intake(
      PHONE_B,
      [{ providerId: 'pm-b', body: 'hello', at: ago(50) }],
      { closedAt: ago(45) },
    );
    await setSessionBlob(legacySession, corrupt);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_B), heldAt: ago(60) });
    const c = await parent(PHONE_C, { place: EASTERN_FSA });
    const cSession = await intake(PHONE_C, [{ providerId: 'pm-c0', body: 'hello', at: ago(50) }], {
      closedAt: ago(45),
      owner: c,
    });
    await setSessionBlob(cSession, corrupt);
    await inboundRow(c, 'pm-c', 'stop texting me', ago(20));
    await hold(PHONE_C, 'pm-c', ago(20));
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-a2', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-a2', ago(20));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recover(new FakeTransport());

    expect(result.legacyFailed).toBe(1);
    expect(await db.database.select().from(schema.optOutReadHolds)).toHaveLength(1);
    expect(result.outcomes.recovery_failed).toBe(1);
    expect((await heldRow('pm-c'))?.readAttempts).toBe(1);
    expect(await channelRevoked(c.parentUserId)).toBe(false);
    // Positive control: the healthy number in the same pass is stopped.
    expect(result.outcomes.stopped).toBe(1);
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain('recovery_failed');
    expect(logged).toContain('SyntaxError');
    for (const id of ['pm-c', c.parentUserId, phoneBlindIndex(PHONE_B), phoneBlindIndex(PHONE_C)]) {
      expect(logged).not.toContain(id);
    }
  }, 30_000);
});

describe("a late stop applies at once; its confirmation waits for the family's own morning", () => {
  /** Tuesday 20 Oct 2026 in the family's Eastern zone (EDT, UTC-4). */
  const LOCAL = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00.000-04:00`);
  const STOP = 'please stop texting me';
  const tick = (r: OptOutReader, transport: FakeTransport, now: Date) =>
    recoverHeldOptOutReads(db.database, deps(r, transport, { now }));

  it('read at 03:00 local: revoked at once, confirmed at the 08:00 slot and not before', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-night', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-night', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();

    const night = await tick(r.reader, transport, LOCAL('03:00'));

    expect(night.outcomes.stopped_confirmation_waiting).toBe(1);
    expect(night.outcomes.stopped).toBe(0);
    // The stop itself takes effect now: the channel is revoked and the withdrawal written.
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(await withdrawals()).toEqual([a.parentUserId]);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-night')).toMatchObject({
      nextReadAt: LOCAL('08:00'),
      stopAppliedAt: LOCAL('03:00'),
    });

    const early = await tick(r.reader, transport, LOCAL('07:59'));
    expect(Object.values(early.outcomes).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(transport.sent).toEqual([]);

    const morning = await tick(r.reader, transport, LOCAL('08:00'));

    expect(morning.outcomes.stopped).toBe(1);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    // The model writes the confirmation it sends, so the text is read again for it.
    expect(r.texts).toEqual([STOP, STOP]);
    expect(await outboundFor(a.parentUserId)).toEqual([{ providerMessageId: 'fake-out-1' }]);
    expect(await withdrawals()).toEqual([a.parentUserId]);
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
    expect(await heldRow('pm-night')).toBeNull();
    expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
  }, 30_000);

  it('a waiting row claimed before its opening still sends nothing until 08:00', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-early', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-early', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();
    await tick(r.reader, transport, LOCAL('03:00'));
    // A row due before its opening (a backoff, a hand fix) is claimed at 06:00.
    await db.database
      .update(schema.optOutHeldMessages)
      .set({ nextReadAt: LOCAL('05:00') })
      .where(eq(schema.optOutHeldMessages.providerMessageId, 'pm-early'));

    const early = await tick(r.reader, transport, LOCAL('06:00'));

    expect(early.outcomes.stopped_confirmation_waiting).toBe(1);
    expect(early.outcomes.stopped).toBe(0);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-early')).toMatchObject({
      nextReadAt: LOCAL('08:00'),
      stopAppliedAt: LOCAL('03:00'),
    });

    // Positive control: the same row at its opening is confirmed once.
    const morning = await tick(r.reader, transport, LOCAL('08:00'));
    expect(morning.outcomes.stopped).toBe(1);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-early')).toBeNull();
  }, 30_000);

  it('positive control: read at 14:00 local, revoked and confirmed in the same tick', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-day', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-day', LOCAL('02:40'), LOCAL('14:00'));
    const transport = new FakeTransport();

    const result = await tick(reader().reader, transport, LOCAL('14:00'));

    expect(result.outcomes.stopped).toBe(1);
    expect(result.outcomes.stopped_confirmation_waiting).toBe(0);
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-day')).toBeNull();
  }, 30_000);

  it('a family that stored only its coarse area keeps its clock: confirmed at 14:00 local', async () => {
    const a = await parent(PHONE_A);
    await db.database
      .update(schema.families)
      .set({ areaCoarse: EASTERN_FSA })
      .where(eq(schema.families.id, a.familyId));
    await inboundRow(a, 'pm-fsa', STOP, LOCAL('13:40'));
    await hold(PHONE_A, 'pm-fsa', LOCAL('13:40'));
    const transport = new FakeTransport();

    const result = await tick(reader().reader, transport, LOCAL('14:00'));

    expect(result.outcomes.stopped_confirmation_dropped).toBe(0);
    expect(result.outcomes.stopped).toBe(1);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
  }, 30_000);

  it('a morning confirmation that left is never sent again when its ledger write throws', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-once', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-once', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();
    await tick(r.reader, transport, LOCAL('03:00'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A real database fault on the outbound ledger row, after the confirmation has left.
    await db.exec(`
      create function refuse_outbound_ledger() returns trigger language plpgsql
        as $$ begin
          if new.direction = 'out' then raise exception 'refused for the test'; end if;
          return new;
        end $$;
      create trigger refuse_outbound_ledger before insert on channel_messages
        for each row execute function refuse_outbound_ledger();
    `);
    try {
      await tick(r.reader, transport, LOCAL('08:00'));
      await tick(r.reader, transport, new Date(LOCAL('08:00').getTime() + heldReadBackoff(3)));
    } finally {
      await db.exec(
        'drop trigger refuse_outbound_ledger on channel_messages; drop function refuse_outbound_ledger();',
      );
    }

    // Positive control: the fault fired, so no outbound ledger row was written.
    expect(await outboundFor(a.parentUserId)).toEqual([]);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-once')).toBeNull();
  }, 30_000);

  it('a family with no place has no clock: revoked at once, the confirmation dropped and the row released', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-nozone', STOP, LOCAL('13:40'));
    await hold(PHONE_A, 'pm-nozone', LOCAL('13:40'));
    const transport = new FakeTransport();

    const result = await tick(reader().reader, transport, LOCAL('14:00'));

    expect(result.outcomes.stopped_confirmation_dropped).toBe(1);
    expect(result.outcomes.stopped).toBe(0);
    // Positive control: the stop itself still applied, at once.
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(await withdrawals()).toEqual([a.parentUserId]);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-nozone')).toBeNull();
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
  }, 30_000);

  it('a waiting row whose family no longer has a place is dropped at its morning, nothing sent', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-lost', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-lost', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();
    await tick(r.reader, transport, LOCAL('03:00'));
    expect((await heldRow('pm-lost'))?.stopAppliedAt).toEqual(LOCAL('03:00'));
    await db.database
      .update(schema.families)
      .set({ postalCode: null, areaCoarse: null })
      .where(eq(schema.families.id, a.familyId));

    const morning = await tick(r.reader, transport, LOCAL('08:00'));

    expect(morning.outcomes.stopped_confirmation_dropped).toBe(1);
    expect(transport.sent).toEqual([]);
    // Nothing to write, so the model is not asked a second time.
    expect(r.texts).toEqual([STOP]);
    expect(await heldRow('pm-lost')).toBeNull();
    expect(await channelRevoked(a.parentUserId)).toBe(true);
  }, 30_000);

  it.each([
    ['the floor closed again that night', LOCAL('21:30')],
    ['the next morning', new Date(LOCAL('09:00').getTime() + 24 * 60 * MINUTE)],
  ])(
    'a confirmation whose first opening the drain missed is dropped (%s), nothing sent',
    async (_when, late) => {
      const a = await parent(PHONE_A, { place: EASTERN_FSA });
      await inboundRow(a, 'pm-missed', STOP, LOCAL('02:40'));
      await hold(PHONE_A, 'pm-missed', LOCAL('02:40'));
      const transport = new FakeTransport();
      const r = reader();
      await tick(r.reader, transport, LOCAL('03:00'));

      const result = await tick(r.reader, transport, late);

      expect(result.outcomes.stopped_confirmation_dropped).toBe(1);
      expect(result.outcomes.stopped).toBe(0);
      expect(transport.sent).toEqual([]);
      expect(r.texts).toEqual([STOP]);
      expect(await heldRow('pm-missed')).toBeNull();
      expect(await isSenderHeld(db.database, phoneBlindIndex(PHONE_A))).toBe(false);
      expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
    },
    30_000,
  );

  it('positive control: a tick still inside the first opening, past its first minute, confirms once', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-late-am', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-late-am', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();
    await tick(r.reader, transport, LOCAL('03:00'));

    const afternoon = await tick(r.reader, transport, LOCAL('15:00'));
    const again = await tick(r.reader, transport, LOCAL('16:00'));

    expect(afternoon.outcomes.stopped).toBe(1);
    expect(again.outcomes.stopped).toBe(0);
    expect(transport.sent.map((s) => [s.to, s.body])).toEqual([
      [PHONE_A, SCRIPTED_STOP_CONFIRMATION],
    ]);
    expect(await heldRow('pm-late-am')).toBeNull();
  }, 30_000);

  it('the owner re-enrolling before the morning supersedes the waiting confirmation', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-back', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-back', LOCAL('02:40'));
    const transport = new FakeTransport();
    const r = reader();
    await tick(r.reader, transport, LOCAL('03:00'));
    // A START at 05:00 writes a fresh verified channel on the number.
    await channel(a, PHONE_A, {
      verifiedAt: LOCAL('05:00'),
      revokedAt: null,
      createdAt: LOCAL('05:00'),
    });

    const morning = await tick(r.reader, transport, LOCAL('08:00'));

    expect(morning.outcomes.stop_superseded).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(await activeChannelOn(a.parentUserId, PHONE_A)).toBe(true);
    expect(await heldRow('pm-back')).toBeNull();
  }, 30_000);

  it('a morning re-read that no longer reads a stop sends nothing and names it', async () => {
    const a = await parent(PHONE_A, { place: EASTERN_FSA });
    await inboundRow(a, 'pm-reread', STOP, LOCAL('02:40'));
    await hold(PHONE_A, 'pm-reread', LOCAL('02:40'));
    const transport = new FakeTransport();
    await tick(reader().reader, transport, LOCAL('03:00'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const morning = await tick(
      reader({ [STOP]: { intent: 'none', confirmation: '', language: 'en' } }).reader,
      transport,
      LOCAL('08:00'),
    );

    expect(morning.outcomes.stopped_confirmation_unsent).toBe(1);
    expect(transport.sent).toEqual([]);
    // Positive control: the stop it applied at night still stands.
    expect(await channelRevoked(a.parentUserId)).toBe(true);
    expect(await heldRow('pm-reread')).toBeNull();
  }, 30_000);
});

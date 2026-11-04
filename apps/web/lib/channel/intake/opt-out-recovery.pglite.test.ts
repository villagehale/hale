import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { pageFailureAlerts } from '~/lib/monitoring/failure-page';
import { runDeletionSweep } from '~/lib/rights/delete';
import { assembleFamilyExport } from '~/lib/rights/export';
import { NO_TEEN_UNLOCKS } from '~/lib/teen-access';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { isSenderHeld } from './opt-out-hold';
import type { OptOutReader, OptOutReading } from './opt-out-reader';
import {
  HELD_READ_BATCH,
  OPT_OUT_RECOVERY_BUDGET_MS,
  type OptOutRecoveryDeps,
  heldReadBackoff,
  recoverHeldOptOutReads,
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

const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);

async function parent(
  phone: string,
  over: { revoked?: boolean; verifiedAt?: Date } = {},
): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Held Family');
  await channel(seeded, phone, {
    verifiedAt: over.verifiedAt ?? ago(60 * 24 * 7),
    revokedAt: over.revoked ? ago(60) : null,
  });
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

function deps(
  r: OptOutReader,
  transport: FakeTransport,
  over: Partial<OptOutRecoveryDeps> = {},
): OptOutRecoveryDeps {
  return {
    reader: r,
    transport,
    preflight: async () => ({ proceed: true, health: null }),
    now: NOW,
    ...over,
  };
}

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

async function channelRevoked(parentUserId: string): Promise<boolean> {
  const [row] = await db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, parentUserId));
  return row?.revokedAt != null;
}

describe('recoverHeldOptOutReads', () => {
  it('a: a stop read late revokes, writes the ledger and audit rows, and confirms once', async () => {
    const a = await parent(PHONE_A);
    const b = await parent(PHONE_B);
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
    const a = await parent(PHONE_A);
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
    const a = await parent(PHONE_A);
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
    const a = await parent(PHONE_A);
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

  it('h: a crisis read late is released, paged by count, and sends nothing', async () => {
    const a = await parent(PHONE_A);
    await inboundRow(a, 'pm-h', 'something is very wrong', ago(20));
    await hold(PHONE_A, 'pm-h', ago(20));
    const transport = new FakeTransport();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(
        reader({ 'something is very wrong': { intent: 'crisis_mental', confirmation: '' } }).reader,
        transport,
      ),
    );

    expect(result.outcomes.read_crisis).toBe(1);
    expect(await heldRow('pm-h')).toBeNull();
    expect(transport.sent).toEqual([]);
    expect(await channelRevoked(a.parentUserId)).toBe(false);
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);
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
    /** Wednesday 21 Oct 2026, 8:00 a.m. in the sitting reminder's zone. */
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

  it('l: a legacy hold is re-pointed at every inbound since it was written', async () => {
    const a = await parent(PHONE_A);
    const heldAt = ago(60);
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: phoneBlindIndex(PHONE_A), heldAt });
    await inboundRow(a, 'pm-before', 'an earlier text', new Date(heldAt.getTime() - MINUTE));
    await inboundRow(a, 'pm-l1', 'stop texting me', new Date(heldAt.getTime() + 1000));
    await inboundRow(a, 'pm-l2', 'see you soon', new Date(heldAt.getTime() + 2 * MINUTE));
    await parent(PHONE_B);
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
      await parent(phone);
      await db.database
        .insert(schema.optOutReadHolds)
        .values({ phoneHash: phoneBlindIndex(phone), heldAt: ago(600 - i) });
    }
    const a = await parent(PHONE_A);
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
    const a = await parent(PHONE_A);
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
    // The ledger row of the confirmation names no chat, never the family group's.
    const outbound = await db.database
      .select({ chatId: schema.channelMessages.providerChatId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, a.parentUserId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(outbound).toEqual([{ chatId: null }]);
  }, 30_000);

  it('n: a stop read late from a one-to-one iMessage keeps its own chat on the ledger', async () => {
    const a = await parent(PHONE_A);
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

  it('a crisis read late for a sender with no family still reaches the #ops count', async () => {
    const session = await createSession(db.database, {
      phoneE164: PHONE_C,
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
            body: 'help it is bad',
            providerId: 'pm-crisis',
            at: ago(20).toISOString(),
          },
        ],
      },
      ago(20),
    );
    await hold(PHONE_C, 'pm-crisis', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(
        reader({ 'help it is bad': { intent: 'crisis_emergency', confirmation: '' } }).reader,
        new FakeTransport(),
      ),
    );
    const texts: string[] = [];
    await pageFailureAlerts(db.database, {
      now: NOW,
      post: async (text) => {
        texts.push(text);
        return 'sent';
      },
    });

    expect(result.outcomes.read_crisis).toBe(1);
    expect(texts.find((text) => text.startsWith('Hale: opt-out reads held.'))).toContain(
      'crisis read late 1.',
    );
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
      outcomes: {
        stopped: 0,
        stopped_confirmation_unsent: 0,
        stopped_confirmation_failed: 0,
        stop_superseded: 0,
        stop_failed: 0,
        already_stopped: 0,
        read_not_stop: 0,
        read_start: 0,
        read_identity: 0,
        read_crisis: 0,
        read_leave_group: 0,
        read_failed: 0,
        not_yet_recorded: 0,
        unrecorded: 0,
        timeline_unresolved: 0,
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
    const id = await intake(PHONE_A, [
      { providerId: 'pm-t2', body: 'stop texting me', at: ago(40) },
    ]);
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

  it('(4) an unverified channel created after the stop supersedes it', async () => {
    await intake(PHONE_A, [{ providerId: 'pm-t4', body: 'stop texting me', at: ago(40) }], {
      closedAt: ago(39),
    });
    await hold(PHONE_A, 'pm-t4', ago(40));
    const vera = await seedFamily(db.database, 'Pending Family');
    await channel(vera, PHONE_A, { verifiedAt: null, revokedAt: null, createdAt: ago(20) });
    const transport = new FakeTransport();

    const result = await recover(transport);

    expect(result.outcomes.stop_superseded).toBe(1);
    expect(await activeChannelOn(vera.parentUserId, PHONE_A)).toBe(true);
    expect(transport.sent).toEqual([]);
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
    const alice = await parent(PHONE_A, { revoked: true });
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

  it('(6) the holder at the time, still current, is stopped, confirmed and released', async () => {
    const before = await seedFamily(db.database, 'Earlier Family');
    await channel(before, PHONE_A, { verifiedAt: ago(7 * DAY), revokedAt: ago(3 * DAY) });
    const u = await parent(PHONE_A, { verifiedAt: ago(2 * DAY) });
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
    const a = await parent(PHONE_A);
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
    const a = await parent(PHONE_A);
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
    const u = await parent(PHONE_A);
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

  it("the read row is about one adult: in neither parent's copy nor the household trail", async () => {
    const a = await parent(PHONE_A);
    const [co] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:co-parent-held', name: 'Robin' })
      .returning({ id: schema.users.id });
    const coParent = co?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: a.familyId, userId: coParent, role: 'co_parent' });
    await inboundRow(a, 'pm-x', 'something is very wrong', ago(20));
    await hold(PHONE_A, 'pm-x', ago(20));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverHeldOptOutReads(
      db.database,
      deps(
        reader({ 'something is very wrong': { intent: 'crisis_mental', confirmation: '' } }).reader,
        new FakeTransport(),
      ),
    );
    expect(result.outcomes.read_crisis).toBe(1);

    // Positive control: the row is written, about the parent who texted, with no outcome.
    const [row] = await db.database
      .select({ id: schema.auditLog.id, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'opt_out_hold_read'));
    expect(row?.after).toBeNull();
    expect(await auditReads(a.familyId)).toEqual([readRow(a.parentUserId)]);

    const trail = await loadTrailForFamily(db.database, a.familyId, NO_TEEN_UNLOCKS);
    expect(trail.map((entry) => entry.id)).not.toContain(row?.id);
    for (const actorUserId of [a.parentUserId, coParent]) {
      const copy = await assembleFamilyExport(db.database, a.familyId, { actorUserId, now: NOW });
      expect(copy.trail.map((entry) => entry.id)).not.toContain(row?.id);
    }
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
    // The erased family's old number, now another parent's: their unread stop may be here.
    await hold(PHONE_C, 'pm-held-by-new-holder', ago(20));
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
  }, 30_000);
});

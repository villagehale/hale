import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { pageFailureAlerts } from '~/lib/monitoring/failure-page';
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
  over: { revoked?: boolean } = {},
): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Held Family');
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: ago(60 * 24 * 7),
    revokedAt: over.revoked ? ago(60) : null,
  });
  return seeded;
}

async function inboundRow(
  owner: { familyId: string; parentUserId: string },
  providerMessageId: string,
  body: string,
  sentAt: Date,
  over: { inGroup?: boolean; chatId?: string } = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.parentUserId,
      channel: over.chatId ? 'imessage' : 'sms',
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

async function auditOutcomes(familyId: string): Promise<unknown[]> {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'opt_out_hold_read'),
      ),
    );
  return rows.map((row) => row.after);
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
    expect(await auditOutcomes(a.familyId)).toEqual([{ outcome: 'stopped' }]);
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
    expect(await auditOutcomes(a.familyId)).toEqual([
      { outcome: 'read_not_stop' },
      { outcome: 'read_not_stop' },
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
    expect(await auditOutcomes(a.familyId)).toEqual([{ outcome: 'read_crisis' }]);
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
  }, 30_000);

  it("a late stop from a number's previous holder never touches its new holder", async () => {
    const before = await parent(PHONE_A, { revoked: true });
    const now = await parent(PHONE_A);
    await inboundRow(before, 'pm-old-holder', 'stop texting me', ago(20));
    await hold(PHONE_A, 'pm-old-holder', ago(20));
    const transport = new FakeTransport();

    const result = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));

    expect(result.outcomes.stopped_previous_holder).toBe(1);
    expect(await channelRevoked(now.parentUserId)).toBe(false);
    expect(transport.sent).toEqual([]);
    expect(await heldRow('pm-old-holder')).toBeNull();
    // Positive control: the new holder's own late stop does revoke them.
    await inboundRow(now, 'pm-new-holder', 'stop texting me', ago(10));
    await hold(PHONE_A, 'pm-new-holder', ago(10));
    const own = await recoverHeldOptOutReads(db.database, deps(reader().reader, transport));
    expect(own.outcomes.stopped).toBe(1);
    expect(await channelRevoked(now.parentUserId)).toBe(true);
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
        stopped_previous_holder: 0,
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

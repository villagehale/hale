import { type AckPromiseOutcome, type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { TURN_ANSWERED_ACTION, TURN_LEDGER_TARGET } from '~/lib/channel/router/turn-ledger';
import type { AckTask } from './read';

/**
 * VIL-717 · THE PROMISED TIME, AS A ROW (`ack_promises`).
 *
 * SEND-TIME ONLY: a promise is written against the outbound row that carried the ack,
 * after the transport took it, so an ack that never left promised nobody anything (the
 * MEM-10 discipline, lib/commitments/ledger.ts). ONE PER TEXT: the unique index on the
 * inbound row is the idempotency anchor, so a retried write conflicts instead of minting a
 * second debt. ONCE PER PROMISE: the sweep claims a row with a conditional update before it
 * composes anything, and a claimed row is never read again.
 *
 * Every write lands with its audit row in the same transaction (rule #6). The rows carry
 * the asking adult as their `audience` (VIL-635): a slow ask is one adult's own question.
 *
 * Nothing here throws to its caller on a write that can fail after a parent already has a
 * message; each failure is a named outcome, logged with the SQLSTATE only, because a
 * Postgres error's detail can carry the row's values.
 */

/** DATA values: what the trail and an access request render. Never renamed with the code. */
export const ACK_PROMISED_ACTION = 'ack_eta_promised';
export const ACK_DEADLINE_ACTION = 'ack_eta_deadline';
export const ACK_LATE_NOTE_SENT_ACTION = 'ack_eta_late_note_sent';

/** The ledger name for the ack and for the late note (`channel_messages.template_key`). */
export const ACK_ETA_TEMPLATE_KEY = 'ack_eta';
export const ACK_LATE_NOTE_TEMPLATE_KEY = 'ack_eta_late_note';

/** How long a settled promise is kept before the sweep deletes it. */
export const ACK_PROMISE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Postgres' "relation does not exist": the table's migration is not applied yet. */
const UNDEFINED_TABLE = '42P01';

function pgErrorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : 'unknown';
}

export type AckPromiseRecordOutcome =
  | { status: 'recorded'; promiseId: string }
  | { status: 'already_promised' }
  | { status: 'not_recorded'; reason: 'not_migrated' | 'write_failed' };

export interface AckPromiseInput {
  familyId: string;
  parentUserId: string;
  /** The parent's text the ack answered. */
  inboundChannelMessageId: string;
  /** The ack's own outbound row: the message that carried the promise. */
  ackChannelMessageId: string;
  task: AckTask;
  channel: 'sms' | 'imessage';
  providerChatId: string | null;
  replyToMessageId: string | null;
  language: string | null;
  /** When the parent's text arrived. */
  askedAt: Date;
  promisedMinutes: number;
  /** When the ack went out. The window is counted from here. */
  now: Date;
}

/** Write down that a sent ack promised a reply within `promisedMinutes`. Never throws. */
export async function recordAckPromise(
  database: Database,
  input: AckPromiseInput,
): Promise<AckPromiseRecordOutcome> {
  try {
    const promiseId = await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.ackPromises)
        .values({
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          inboundChannelMessageId: input.inboundChannelMessageId,
          ackChannelMessageId: input.ackChannelMessageId,
          task: input.task,
          channel: input.channel,
          providerChatId: input.providerChatId,
          replyToMessageId: input.replyToMessageId,
          language: input.language,
          askedAt: input.askedAt,
          promisedMinutes: input.promisedMinutes,
          dueAt: new Date(input.now.getTime() + input.promisedMinutes * 60_000),
        })
        .onConflictDoNothing({ target: schema.ackPromises.inboundChannelMessageId })
        .returning({ id: schema.ackPromises.id });
      if (!row) return null;
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'ack_eta_promised',
        targetTable: 'ack_promises',
        targetId: row.id,
        after: { task: input.task, promisedMinutes: input.promisedMinutes, channel: input.channel },
        audience: input.parentUserId,
      });
      return row.id;
    });
    if (promiseId === null) return { status: 'already_promised' };
    return { status: 'recorded', promiseId };
  } catch (err) {
    const code = pgErrorCode(err);
    console.error(
      { code, familyId: input.familyId },
      'ack eta: the promise was not recorded - no late note can follow this ack',
    );
    return {
      status: 'not_recorded',
      reason: code === UNDEFINED_TABLE ? 'not_migrated' : 'write_failed',
    };
  }
}

/** One promise whose stated time has passed and that no sweep has claimed. */
export interface DueAckPromise {
  id: string;
  familyId: string;
  parentUserId: string;
  inboundChannelMessageId: string;
  task: AckTask;
  channel: 'sms' | 'imessage';
  providerChatId: string | null;
  replyToMessageId: string | null;
  language: string | null;
  askedAt: Date;
  promisedMinutes: number;
  dueAt: Date;
}

/** The oldest unclaimed promises that have come due. Reads the partial index only. */
export async function loadDueAckPromises(
  database: Database,
  now: Date,
  limit: number,
): Promise<DueAckPromise[]> {
  const rows = await database
    .select({
      id: schema.ackPromises.id,
      familyId: schema.ackPromises.familyId,
      parentUserId: schema.ackPromises.parentUserId,
      inboundChannelMessageId: schema.ackPromises.inboundChannelMessageId,
      task: schema.ackPromises.task,
      channel: schema.ackPromises.channel,
      providerChatId: schema.ackPromises.providerChatId,
      replyToMessageId: schema.ackPromises.replyToMessageId,
      language: schema.ackPromises.language,
      askedAt: schema.ackPromises.askedAt,
      promisedMinutes: schema.ackPromises.promisedMinutes,
      dueAt: schema.ackPromises.dueAt,
    })
    .from(schema.ackPromises)
    .where(and(isNull(schema.ackPromises.claimedAt), lte(schema.ackPromises.dueAt, now)))
    .orderBy(asc(schema.ackPromises.dueAt))
    .limit(limit);
  // The CHECK constraints hold task and channel to these values; the casts restate them.
  return rows.map((row) => ({
    ...row,
    task: row.task as AckTask,
    channel: row.channel as 'sms' | 'imessage',
  }));
}

/**
 * Claim one due promise for this sweep. True only for the one sweep whose update took the
 * row, so two overlapping ticks can never both compose or send a note for it.
 */
export async function claimAckPromise(database: Database, id: string, now: Date): Promise<boolean> {
  const rows = await database
    .update(schema.ackPromises)
    .set({ claimedAt: now })
    .where(and(eq(schema.ackPromises.id, id), isNull(schema.ackPromises.claimedAt)))
    .returning({ id: schema.ackPromises.id });
  return rows.length > 0;
}

/** Settle a claimed promise with its named outcome, and its audit row, in one transaction. */
export async function settleAckPromise(
  database: Database,
  input: {
    promise: Pick<DueAckPromise, 'id' | 'familyId' | 'parentUserId'>;
    outcome: AckPromiseOutcome;
    /** Why, for the outcomes that have more than one cause. A closed vocabulary, never text. */
    reason?: string;
    noteChannelMessageId?: string | null;
    now: Date;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .update(schema.ackPromises)
      .set({
        settledAt: input.now,
        outcome: input.outcome,
        noteChannelMessageId: input.noteChannelMessageId ?? null,
      })
      .where(
        and(eq(schema.ackPromises.id, input.promise.id), isNull(schema.ackPromises.settledAt)),
      );
    await tx.insert(schema.auditLog).values({
      familyId: input.promise.familyId,
      actor: 'system',
      actionTaken: 'ack_eta_deadline',
      targetTable: 'ack_promises',
      targetId: input.promise.id,
      after: { outcome: input.outcome, ...(input.reason ? { reason: input.reason } : {}) },
      audience: input.promise.parentUserId,
    });
  });
}

/**
 * Whether the reply the ack promised has landed.
 *
 * `answered`: the turn ledger has an answered row for that text (wiring.ts
 * auditTurnLedger), whichever path answered it: the turn itself, its re-drive, or a turn it
 * was folded into. `closed_unanswered`: the turn is over (its routed claim is written, see
 * route.ts `done`) and nothing answered it. `open`: neither, so the text is still being
 * worked on or waits in the queue for its next attempt.
 *
 * The answered read is family-scoped and starts at the ask, so it rides the audit log's
 * (family_id, occurred_at) index.
 */
export type AckReplyState = 'answered' | 'closed_unanswered' | 'open';

export async function ackReplyState(
  database: Database,
  promise: Pick<DueAckPromise, 'familyId' | 'inboundChannelMessageId' | 'askedAt'>,
): Promise<AckReplyState> {
  const answered = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, promise.familyId),
        gte(schema.auditLog.occurredAt, new Date(promise.askedAt.getTime() - 60_000)),
        eq(schema.auditLog.actionTaken, TURN_ANSWERED_ACTION),
        eq(schema.auditLog.targetTable, TURN_LEDGER_TARGET),
        eq(schema.auditLog.targetId, promise.inboundChannelMessageId),
      ),
    )
    .limit(1);
  if (answered.length > 0) return 'answered';
  const closed = await database
    .select({ id: schema.channelTurnAnswerClaims.id })
    .from(schema.channelTurnAnswerClaims)
    .where(eq(schema.channelTurnAnswerClaims.channelMessageId, promise.inboundChannelMessageId))
    .limit(1);
  return closed.length > 0 ? 'closed_unanswered' : 'open';
}

/**
 * Delete promises claimed longer ago than the retention window: settled ones, and the rare
 * one a sweep claimed and then died before settling (it is never sent twice, and it is not
 * kept forever either). Returns how many.
 */
export async function pruneSettledAckPromises(database: Database, now: Date): Promise<number> {
  const rows = await database
    .delete(schema.ackPromises)
    .where(
      and(
        isNotNull(schema.ackPromises.claimedAt),
        lt(schema.ackPromises.claimedAt, new Date(now.getTime() - ACK_PROMISE_RETENTION_MS)),
      ),
    )
    .returning({ id: schema.ackPromises.id });
  return rows.length;
}

/**
 * The late note's own ledger rows, written after the transport took it: a
 * `channel_messages` row with no body (rule #1) and its audit row, in one transaction.
 * Returns the row id. Throws on a failed write; the sweep names that and settles anyway,
 * because the parent already has the note and a retry would text them twice.
 */
export async function recordLateNote(
  database: Database,
  input: {
    promise: Pick<DueAckPromise, 'id' | 'familyId' | 'parentUserId'>;
    sent: { providerMessageId: string; channel: 'sms' | 'imessage'; chatId: string | null };
    now: Date;
  },
): Promise<string> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.channelMessages)
      .values({
        familyId: input.promise.familyId,
        parentUserId: input.promise.parentUserId,
        channel: input.sent.channel,
        direction: 'out',
        // A reply-class line: part of the conversation the parent started minutes ago, so
        // no proactive cap or category budget counts it.
        category: 'reply',
        templateKey: ACK_LATE_NOTE_TEMPLATE_KEY,
        providerMessageId: input.sent.providerMessageId,
        providerChatId: input.sent.chatId,
        status: acceptedStatus(input.sent.channel),
        body: null,
        sentAt: input.now,
      })
      .returning({ id: schema.channelMessages.id });
    const id = row?.id;
    if (!id) throw new Error('ack eta: late note ledger insert returned no row');
    await tx.insert(schema.auditLog).values({
      familyId: input.promise.familyId,
      actor: 'system',
      actionTaken: 'ack_eta_late_note_sent',
      targetTable: 'channel_messages',
      targetId: id,
      after: { promise: input.promise.id },
      audience: input.promise.parentUserId,
    });
    return id;
  });
}

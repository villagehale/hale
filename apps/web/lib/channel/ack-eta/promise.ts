import { type AckPromiseOutcome, type Database, schema } from '@hale/db';
import { and, asc, eq, gt, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { HOLDING_LINE_TEMPLATE_KEY } from '~/lib/channel/router/holding-line';
import {
  SIDE_TURN_TEMPLATE_KEY,
  TURN_ANSWERED_ACTION,
  TURN_FAILED_ACTION,
  TURN_LEDGER_TARGET,
  TURN_NOTHING_SENT,
  type TurnFailureReason,
} from '~/lib/channel/router/turn-ledger';
import { turnWasDeadLettered } from '~/lib/monitoring/failure-page';
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
 * the asking adult as their `audience` (VIL-635) and are keyed on that adult
 * (`users/<id>`, the promise named in `after`): a slow ask is one adult's own question, so
 * their access copy holds it and the family copy does not (rights/export.ts).
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
        targetTable: 'users',
        targetId: input.parentUserId,
        after: {
          promise: row.id,
          task: input.task,
          promisedMinutes: input.promisedMinutes,
          channel: input.channel,
        },
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
  /** When a night hold on this row ended, or null when it was never held. */
  heldUntil: Date | null;
  createdAt: Date;
}

/**
 * The oldest unclaimed promises that have come due and are not being held through the
 * parent's night. Reads the partial index only.
 */
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
      heldUntil: schema.ackPromises.heldUntil,
      createdAt: schema.ackPromises.createdAt,
    })
    .from(schema.ackPromises)
    .where(
      and(
        isNull(schema.ackPromises.claimedAt),
        lte(schema.ackPromises.dueAt, now),
        or(isNull(schema.ackPromises.heldUntil), lte(schema.ackPromises.heldUntil, now)),
      ),
    )
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

/**
 * Keep a due promise out of the sweep until `until`, unclaimed: its note is owed, and it is
 * night on the parent's clock. Two overlapping ticks write the same morning.
 */
export async function holdAckPromise(database: Database, id: string, until: Date): Promise<void> {
  await database
    .update(schema.ackPromises)
    .set({ heldUntil: until })
    .where(and(eq(schema.ackPromises.id, id), isNull(schema.ackPromises.claimedAt)));
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
      targetTable: 'users',
      targetId: input.promise.parentUserId,
      after: {
        promise: input.promise.id,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      audience: input.promise.parentUserId,
    });
  });
}

/**
 * Give a claim back: this sweep sent nothing it can be sure of, so the note is still owed
 * and the next tick may try it, under the same Linq key. Conditional on this sweep's own
 * claim. `sendAttempted` is what a later `stale` ending reads to say the note may have gone.
 */
export async function releaseAckClaim(
  database: Database,
  input: {
    promise: Pick<DueAckPromise, 'id' | 'familyId' | 'parentUserId'>;
    claimedAt: Date;
    reason: string;
    sendAttempted: boolean;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .update(schema.ackPromises)
      .set({ claimedAt: null })
      .where(
        and(
          eq(schema.ackPromises.id, input.promise.id),
          eq(schema.ackPromises.claimedAt, input.claimedAt),
          isNull(schema.ackPromises.settledAt),
        ),
      );
    await tx.insert(schema.auditLog).values({
      familyId: input.promise.familyId,
      actor: 'system',
      actionTaken: 'ack_eta_deadline',
      targetTable: 'users',
      targetId: input.promise.parentUserId,
      after: {
        promise: input.promise.id,
        outcome: 'retrying',
        reason: input.reason,
        sendAttempted: input.sendAttempted,
      },
      audience: input.promise.parentUserId,
    });
  });
}

/** Whether an earlier tick tried this note's send and could not tell if it landed. */
export async function ackSendWasAttempted(
  database: Database,
  promise: Pick<DueAckPromise, 'id' | 'familyId' | 'parentUserId' | 'askedAt'>,
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, promise.familyId),
        gte(schema.auditLog.occurredAt, promise.askedAt),
        eq(schema.auditLog.actionTaken, 'ack_eta_deadline'),
        eq(schema.auditLog.targetTable, 'users'),
        eq(schema.auditLog.targetId, promise.parentUserId),
        sql`${schema.auditLog.after}->>'promise' = ${promise.id}`,
        sql`${schema.auditLog.after}->>'sendAttempted' = 'true'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Whether this text already carries a promise. An unmigrated table holds none. */
export async function ackPromiseFor(
  database: Database,
  inboundChannelMessageId: string,
): Promise<boolean> {
  try {
    const rows = await database
      .select({ id: schema.ackPromises.id })
      .from(schema.ackPromises)
      .where(eq(schema.ackPromises.inboundChannelMessageId, inboundChannelMessageId))
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    if (pgErrorCode(err) === UNDEFINED_TABLE) return false;
    throw err;
  }
}

/** The family asked to be erased (or is gone): nothing unprompted goes to them. */
export async function familyErasureScheduled(
  database: Database,
  familyId: string,
): Promise<boolean> {
  const [family] = await database
    .select({ scheduledDeletionAt: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return family === undefined || family.scheduledDeletionAt !== null;
}

/**
 * Whether the reply the ack promised has landed.
 *
 * `answered`: the turn ledger has an answered row for that text (wiring.ts
 * auditTurnLedger), whichever path answered it: the turn itself, its re-drive, or a turn it
 * was folded into. `closed_unanswered` needs a positive fact that nothing reached the
 * parent: an answered row marked {@link TURN_NOTHING_SENT} (it stops a re-drive, but they
 * heard nothing), a failed row naming {@link NOTHING_WENT_FAILURE}, or a closed turn with no
 * reply on the delivery ledger between the ack and the close. The routed claim alone is not
 * that fact: the answered row is written after Linq took the reply and its failure is
 * swallowed (route.ts `claimAnswerQuietly`), so a closed turn with no answered row may still
 * have answered. `open`: neither, so the text is still being worked on or waits in the queue
 * for its next attempt.
 *
 * The answered read is family-scoped and starts at the ask, so it rides the audit log's
 * (family_id, occurred_at) index.
 */
export type AckReplyState = 'answered' | 'closed_unanswered' | 'open';

/**
 * The one failure that closes a turn with nothing sent and no answered row to mark: the
 * draft notice could not be written (route.ts `disposeOfFailedTurn`). The other silent
 * failures claim the turn and carry {@link TURN_NOTHING_SENT}.
 */
const NOTHING_WENT_FAILURE: TurnFailureReason = 'notice_unsent';

function afterField(after: unknown, key: string): unknown {
  return typeof after === 'object' && after !== null
    ? (after as Record<string, unknown>)[key]
    : undefined;
}

export async function ackReplyState(
  database: Database,
  promise: Pick<
    DueAckPromise,
    'familyId' | 'parentUserId' | 'inboundChannelMessageId' | 'askedAt' | 'createdAt'
  >,
): Promise<AckReplyState> {
  const turnRows = await database
    .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, promise.familyId),
        gte(schema.auditLog.occurredAt, new Date(promise.askedAt.getTime() - 60_000)),
        inArray(schema.auditLog.actionTaken, [TURN_ANSWERED_ACTION, TURN_FAILED_ACTION]),
        eq(schema.auditLog.targetTable, TURN_LEDGER_TARGET),
        eq(schema.auditLog.targetId, promise.inboundChannelMessageId),
      ),
    );
  const answered = turnRows.filter((row) => row.action === TURN_ANSWERED_ACTION);
  if (
    answered.some((row) => afterField(row.after, 'nothing_sent') !== TURN_NOTHING_SENT.nothing_sent)
  ) {
    return 'answered';
  }
  if (answered.length > 0) return 'closed_unanswered';
  if (
    turnRows.some(
      (row) =>
        row.action === TURN_FAILED_ACTION &&
        afterField(row.after, 'reason') === NOTHING_WENT_FAILURE,
    )
  ) {
    return 'closed_unanswered';
  }
  const closed = await database
    .select({ id: schema.channelTurnAnswerClaims.id })
    .from(schema.channelTurnAnswerClaims)
    .where(eq(schema.channelTurnAnswerClaims.channelMessageId, promise.inboundChannelMessageId))
    .limit(1);
  if (closed.length === 0) {
    const deadLettered = await turnWasDeadLettered(database, {
      familyId: promise.familyId,
      channelMessageId: promise.inboundChannelMessageId,
    });
    return deadLettered ? 'closed_unanswered' : 'open';
  }
  return (await replyOnLedgerBeforeClose(database, promise)) ? 'answered' : 'closed_unanswered';
}

/** Lines that go out beside an answer and are never one. */
const NOT_AN_ANSWER = [ACK_ETA_TEMPLATE_KEY, HOLDING_LINE_TEMPLATE_KEY, SIDE_TURN_TEMPLATE_KEY];

/**
 * Whether the delivery ledger holds this turn's own reply: a reply-class row to this parent
 * written after the promise and no later than the turn's close. The promise is written
 * before the answer can go (the ack's `settle`), and the turn writes its receipt before
 * `done()` closes it. Past the close a row is some other send: nudges and polls write this
 * category too (monitoring/reply-latency.ts). Compared in SQL, because a JS `Date` would
 * drop the close's microseconds and could fall below the reply it must include.
 */
async function replyOnLedgerBeforeClose(
  database: Database,
  promise: Pick<
    DueAckPromise,
    'familyId' | 'parentUserId' | 'inboundChannelMessageId' | 'createdAt'
  >,
): Promise<boolean> {
  const replies = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .innerJoin(
      schema.channelTurnAnswerClaims,
      eq(schema.channelTurnAnswerClaims.channelMessageId, promise.inboundChannelMessageId),
    )
    .where(
      and(
        eq(schema.channelMessages.parentUserId, promise.parentUserId),
        eq(schema.channelMessages.category, 'reply'),
        gt(schema.channelMessages.createdAt, promise.createdAt),
        lte(schema.channelMessages.createdAt, schema.channelTurnAnswerClaims.claimedAt),
        eq(schema.channelMessages.familyId, promise.familyId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        or(
          isNull(schema.channelMessages.templateKey),
          notInArray(schema.channelMessages.templateKey, NOT_AN_ANSWER),
        ),
      ),
    )
    .limit(1);
  return replies.length > 0;
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
        category: PROACTIVE_CATEGORY.ack_late_note,
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
      // Keyed on the adult it was sent to: their access copy keeps it (rights/export.ts).
      targetTable: 'users',
      targetId: input.promise.parentUserId,
      after: { promise: input.promise.id, channelMessage: id },
      audience: input.promise.parentUserId,
    });
    return id;
  });
}

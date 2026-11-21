import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { isUndefinedTable } from '~/lib/channel/linq/roster';
import { groupReminderInFlightCancelEnabled } from './flag';

/**
 * VIL-448 (T26) — the `group_reminders` rows: set, armed, cancelled, claimed and closed.
 *
 * Every state change is one guarded UPDATE, so two ticks or a STOP racing a send cannot
 * both win. A tick's claim is the `updated_at` it stamped: once a STOP, a cancel or a
 * later tick has taken the row, the tick's commit and its close both find the claim gone
 * and do nothing. The commit is the one moment a send becomes certain: before it a STOP
 * wins and nothing goes out, after it the STOP leaves the row alone and the row says
 * what the chat saw. Every close clears `what`, the member's own words, and only a close
 * that happened writes an audit row.
 */

/** A claim older than this is a tick that died or failed mid-send; it may be taken again. */
export const SENDING_STALE_MS = 10 * 60_000;
export const DUE_BATCH = 25;

/**
 * Queued, not yet committed to a send: a cancel or a STOP still wins, even over a tick
 * that has claimed the row (`sending`). `in_flight` joins them only while
 * `GROUP_REMINDER_INFLIGHT_CANCEL_ENABLED` is exactly `true`, and only when Linq has
 * not accepted the send (no provider message id).
 */
const CANCELLABLE: schema.GroupReminderStatus[] = ['pending', 'scheduled', 'sending'];

const LANDED_AFTER_STOP = 'group_reminder_landed_after_stop';

/** Linq has not accepted this reminder's send. The dedupe key is the ledger's. */
function providerNotYetAccepted() {
  return sql`not exists (
    select 1 from ${schema.channelMessages}
    where ${schema.channelMessages.providerMessageId} is not null
      and (
        ${schema.channelMessages.dedupeKey} = ('linq:group_reminder:' || ${schema.groupReminders.id}::text)
        or ${schema.channelMessages.dedupeKey} = ('linq:group_reminder_direct:' || ${schema.groupReminders.id}::text)
      )
  )`;
}

function providerAlreadyAccepted() {
  return sql`exists (
    select 1 from ${schema.channelMessages}
    where ${schema.channelMessages.providerMessageId} is not null
      and (
        ${schema.channelMessages.dedupeKey} = ('linq:group_reminder:' || ${schema.groupReminders.id}::text)
        or ${schema.channelMessages.dedupeKey} = ('linq:group_reminder_direct:' || ${schema.groupReminders.id}::text)
      )
  )`;
}

/** Queued rows always. In-flight rows only when the flag is exactly `true` and Linq has not taken the send. */
function stillCancellable() {
  const queued = inArray(schema.groupReminders.status, CANCELLABLE);
  if (!groupReminderInFlightCancelEnabled()) return queued;
  return or(queued, and(eq(schema.groupReminders.status, 'in_flight'), providerNotYetAccepted()));
}

/** A tick holds the row: checking and writing it (`sending`), or sending it now (`in_flight`). */
const CLAIMED: schema.GroupReminderStatus[] = ['sending', 'in_flight'];

export type GroupReminderRow = schema.GroupReminder;

export type CancelReason =
  | 'asked'
  | 'member_stop'
  | 'member_removed'
  | 'group_ejected'
  | 'confirm_unwritten'
  | 'confirm_not_sent'
  | 'confirm_held';

/** Open reminders this person may move or cancel: ones they asked for, or that are for them. */
export async function openRemindersFor(
  database: Database,
  input: { chatId: string; phoneHash: string; now: Date; limit?: number },
): Promise<GroupReminderRow[]> {
  return database
    .select()
    .from(schema.groupReminders)
    .where(
      and(
        eq(schema.groupReminders.chatId, input.chatId),
        eq(schema.groupReminders.status, 'scheduled'),
        gt(schema.groupReminders.deliverAt, input.now),
        or(
          eq(schema.groupReminders.askedByPhoneHash, input.phoneHash),
          eq(schema.groupReminders.forPhoneHash, input.phoneHash),
        ),
      ),
    )
    .orderBy(asc(schema.groupReminders.deliverAt))
    .limit(input.limit ?? 10);
}

/** Writes the turn's reminders as `pending`. A replayed ask writes nothing twice. */
export async function insertPendingReminders(
  database: Database,
  rows: schema.NewGroupReminder[],
): Promise<GroupReminderRow[]> {
  if (rows.length === 0) return [];
  return database
    .insert(schema.groupReminders)
    .values(rows.map((row) => ({ ...row, status: 'pending' as const })))
    .onConflictDoNothing()
    .returning();
}

/** Unarmed rows whose confirmation never went out, removed so a redelivery can set them. */
export async function releasePendingReminders(database: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await database
    .delete(schema.groupReminders)
    .where(
      and(inArray(schema.groupReminders.id, ids), eq(schema.groupReminders.status, 'pending')),
    );
}

/** The confirmation reached the chat: the reminders may now fire. */
export async function armReminders(database: Database, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await database
    .update(schema.groupReminders)
    .set({ status: 'scheduled', updatedAt: now })
    .where(
      and(inArray(schema.groupReminders.id, ids), eq(schema.groupReminders.status, 'pending')),
    );
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function auditCancelled(
  tx: Tx,
  rows: readonly Pick<GroupReminderRow, 'id' | 'familyId'>[],
  reason: CancelReason,
  actor: string,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(schema.auditLog).values(
    rows.map((row) => ({
      familyId: row.familyId,
      actor,
      actionTaken: 'group_reminder_cancelled',
      targetTable: 'group_reminders',
      targetId: row.id,
      after: { reason },
    })),
  );
}

/**
 * An in-flight reminder Linq already accepted cannot be pulled back. The audit row
 * says `landed_after_stop` so the send is visible. One row per reminder.
 */
async function auditAcceptedInFlight(
  tx: Tx,
  scope: ReturnType<typeof and> | ReturnType<typeof eq> | undefined,
  actor: string,
): Promise<void> {
  if (!groupReminderInFlightCancelEnabled()) return;
  const landed = await tx
    .select({ id: schema.groupReminders.id, familyId: schema.groupReminders.familyId })
    .from(schema.groupReminders)
    .where(and(scope, eq(schema.groupReminders.status, 'in_flight'), providerAlreadyAccepted()));
  if (landed.length === 0) return;
  const existing = await tx
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, LANDED_AFTER_STOP),
        inArray(
          schema.auditLog.targetId,
          landed.map((row) => row.id),
        ),
      ),
    );
  const seen = new Set(existing.map((row) => row.targetId));
  const fresh = landed.filter((row) => !seen.has(row.id));
  if (fresh.length === 0) return;
  await tx.insert(schema.auditLog).values(
    fresh.map((row) => ({
      familyId: row.familyId,
      actor,
      actionTaken: LANDED_AFTER_STOP,
      targetTable: 'group_reminders',
      targetId: row.id,
      after: { reason: 'landed_after_stop' },
    })),
  );
}

/**
 * The provider accepted a reminder a STOP had already cancelled. Writes
 * `landed_after_stop` once. No row when Linq has no message id, or the flag is off.
 */
export async function auditLandedAfterStop(
  database: Database,
  row: Pick<GroupReminderRow, 'id' | 'familyId'>,
): Promise<void> {
  if (!groupReminderInFlightCancelEnabled()) return;
  const [current] = await database
    .select({ status: schema.groupReminders.status })
    .from(schema.groupReminders)
    .where(eq(schema.groupReminders.id, row.id))
    .limit(1);
  if (current?.status !== 'cancelled') return;
  const [sent] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        inArray(schema.channelMessages.dedupeKey, [
          `linq:group_reminder:${row.id}`,
          `linq:group_reminder_direct:${row.id}`,
        ]),
        isNotNull(schema.channelMessages.providerMessageId),
      ),
    )
    .limit(1);
  if (!sent) return;
  const [already] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.actionTaken, LANDED_AFTER_STOP), eq(schema.auditLog.targetId, row.id)),
    )
    .limit(1);
  if (already) return;
  await database.insert(schema.auditLog).values({
    familyId: row.familyId,
    actor: 'system',
    actionTaken: LANDED_AFTER_STOP,
    targetTable: 'group_reminders',
    targetId: row.id,
    after: { reason: 'landed_after_stop' },
  });
}

/** Cancels these reminders while they are still unsent. Returns the ones it closed. */
export async function cancelReminders(
  database: Database,
  input: { ids: string[]; reason: CancelReason; actor: string; now: Date },
): Promise<GroupReminderRow[]> {
  if (input.ids.length === 0) return [];
  return database.transaction(async (tx) => {
    const closed = await tx
      .update(schema.groupReminders)
      .set({
        status: 'cancelled',
        statusReason: input.reason,
        what: null,
        closedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(inArray(schema.groupReminders.id, input.ids), stillCancellable()))
      .returning();
    await auditCancelled(tx, closed, input.reason, input.actor);
    await auditAcceptedInFlight(tx, inArray(schema.groupReminders.id, input.ids), input.actor);
    return closed;
  });
}

/**
 * STOP works per member. A member who stops Hale in the group, or is taken out of the
 * chat, loses every unsent reminder they asked for and every one that is for them,
 * including one a tick has claimed and is still writing. One already going out
 * (`in_flight`) is left to land unless `GROUP_REMINDER_INFLIGHT_CANCEL_ENABLED` is
 * exactly `true`: then a row Linq has not accepted yet is cancelled, and one Linq
 * has accepted is audited `landed_after_stop` and left to close as sent. Hale leaving the group (`phoneHash` absent)
 * cancels the whole chat's. Silent: a STOP is acknowledged once by the roster flow, and
 * nothing more is said. A database without the table has nothing to cancel, and says so
 * by name rather than failing the STOP.
 */
export async function cancelGroupReminders(
  database: Database,
  input: { chatId: string; phoneHash?: string; reason: CancelReason; now: Date },
): Promise<number | 'not_migrated'> {
  const scope = input.phoneHash
    ? or(
        eq(schema.groupReminders.askedByPhoneHash, input.phoneHash),
        eq(schema.groupReminders.forPhoneHash, input.phoneHash),
      )
    : undefined;
  let closed: GroupReminderRow[];
  try {
    closed = await database.transaction(async (tx) => {
      const rows = await tx
        .update(schema.groupReminders)
        .set({
          status: 'cancelled',
          statusReason: input.reason,
          what: null,
          closedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(schema.groupReminders.chatId, input.chatId), stillCancellable(), scope))
        .returning();
      await auditCancelled(tx, rows, input.reason, 'system');
      await auditAcceptedInFlight(
        tx,
        and(eq(schema.groupReminders.chatId, input.chatId), scope),
        'system',
      );
      return rows;
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    console.warn({ outcome: 'not_migrated' }, 'group reminders: table missing, nothing cancelled');
    return 'not_migrated';
  }
  if (closed.length > 0) {
    console.info(
      { outcome: 'group_reminders_cancelled', reason: input.reason, count: closed.length },
      'group reminders: cancelled',
    );
  }
  return closed.length;
}

function claimable(now: Date) {
  const stale = new Date(now.getTime() - SENDING_STALE_MS);
  return or(
    eq(schema.groupReminders.status, 'scheduled'),
    and(inArray(schema.groupReminders.status, CLAIMED), lt(schema.groupReminders.updatedAt, stale)),
  );
}

/** Reminders whose time has come, oldest first. */
export async function dueReminders(
  database: Database,
  now: Date,
  limit = DUE_BATCH,
): Promise<GroupReminderRow[]> {
  return database
    .select()
    .from(schema.groupReminders)
    .where(and(lte(schema.groupReminders.deliverAt, now), claimable(now)))
    .orderBy(asc(schema.groupReminders.deliverAt))
    .limit(limit);
}

/**
 * Takes one due reminder for this tick. The returned row's `updatedAt` is the claim.
 * Null: another tick, a STOP or a cancel got it first.
 */
export async function claimReminder(
  database: Database,
  id: string,
  now: Date,
): Promise<GroupReminderRow | null> {
  const [row] = await database
    .update(schema.groupReminders)
    .set({ status: 'sending', updatedAt: now })
    .where(and(eq(schema.groupReminders.id, id), claimable(now)))
    .returning();
  return row ?? null;
}

type Claim = Pick<GroupReminderRow, 'id' | 'updatedAt'>;

function heldClaim(claim: Claim, statuses: schema.GroupReminderStatus[] = CLAIMED) {
  return and(
    eq(schema.groupReminders.id, claim.id),
    inArray(schema.groupReminders.status, statuses),
    eq(schema.groupReminders.updatedAt, claim.updatedAt),
  );
}

/**
 * Commits the tick to sending, once the text is written and just before it goes. False:
 * a STOP, a cancel or a later tick took the row first, and nothing may be sent.
 */
export async function commitSend(database: Database, claim: Claim): Promise<boolean> {
  const [row] = await database
    .update(schema.groupReminders)
    .set({ status: 'in_flight' })
    .where(heldClaim(claim, ['sending']))
    .returning({ id: schema.groupReminders.id });
  return Boolean(row);
}

/** A send that did not land and may be tried again: until then, a STOP or a cancel may take it back. */
export async function releaseSend(database: Database, claim: Claim): Promise<void> {
  await database
    .update(schema.groupReminders)
    .set({ status: 'sending' })
    .where(heldClaim(claim, ['in_flight']));
}

const CLOSE_ACTION = {
  sent: 'group_reminder_sent',
  dropped: 'group_reminder_dropped',
  failed: 'group_reminder_failed',
} as const;

/**
 * Closes a claimed reminder as sent, dropped or failed, together with its audit row.
 * False: the claim was no longer this tick's, so nothing changed and nothing is audited.
 */
export async function closeReminder(
  database: Database,
  row: Claim & Pick<GroupReminderRow, 'familyId' | 'delivery'>,
  input: {
    status: keyof typeof CLOSE_ACTION;
    reason: string | null;
    now: Date;
    after?: Record<string, unknown>;
  },
): Promise<boolean> {
  const closed = await database.transaction(async (tx) => {
    const [taken] = await tx
      .update(schema.groupReminders)
      .set({
        status: input.status,
        statusReason: input.reason,
        what: null,
        closedAt: input.now,
        updatedAt: input.now,
      })
      .where(heldClaim(row))
      .returning({ id: schema.groupReminders.id });
    if (!taken) return false;
    await tx.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: CLOSE_ACTION[input.status],
      targetTable: 'group_reminders',
      targetId: row.id,
      after: { delivery: row.delivery, reason: input.reason, ...input.after },
    });
    return true;
  });
  if (!closed) {
    console.warn(
      { reminderId: row.id, outcome: 'claim_lost', status: input.status },
      'group reminders: the claim was taken, not closed',
    );
  }
  return closed;
}

/** The chat's ledger row for an inbound message already exists: a webhook replay. */
export async function inboundAlreadyRecorded(
  database: Database,
  providerMessageId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerMessageId, providerMessageId),
        sql`${schema.channelMessages.direction} = 'in'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

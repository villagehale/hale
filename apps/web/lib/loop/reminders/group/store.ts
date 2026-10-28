import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { isUndefinedTable } from '~/lib/channel/linq/roster';

/**
 * VIL-448 (T26) — the `group_reminders` rows: set, armed, cancelled, claimed and closed.
 *
 * Every state change is one guarded UPDATE, so two ticks or a STOP racing a send cannot
 * both win. Every close clears `what`, the member's own words, and writes its audit row.
 */

/** A `sending` claim older than this is a tick that died mid-send; it may be taken again. */
export const SENDING_STALE_MS = 10 * 60_000;
export const DUE_BATCH = 25;

export type GroupReminderRow = schema.GroupReminder;

export type CancelReason =
  | 'asked'
  | 'member_stop'
  | 'member_removed'
  | 'group_ejected'
  | 'confirm_unwritten'
  | 'confirm_not_sent';

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

async function auditCancelled(
  database: Database,
  rows: readonly Pick<GroupReminderRow, 'id' | 'familyId' | 'askedByUserId'>[],
  reason: CancelReason,
  actor: string,
): Promise<void> {
  if (rows.length === 0) return;
  await database.insert(schema.auditLog).values(
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

/** Cancels these reminders while they are still open. Returns the ones it closed. */
export async function cancelReminders(
  database: Database,
  input: { ids: string[]; reason: CancelReason; actor: string; now: Date },
): Promise<GroupReminderRow[]> {
  if (input.ids.length === 0) return [];
  const closed = await database
    .update(schema.groupReminders)
    .set({
      status: 'cancelled',
      statusReason: input.reason,
      what: null,
      closedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        inArray(schema.groupReminders.id, input.ids),
        inArray(schema.groupReminders.status, ['pending', 'scheduled']),
      ),
    )
    .returning();
  await auditCancelled(database, closed, input.reason, input.actor);
  return closed;
}

/**
 * STOP works per member. A member who stops Hale in the group, or is taken out of the
 * chat, loses every open reminder they asked for and every one that is for them. Hale
 * leaving the group (`phoneHash` absent) cancels the whole chat's. Silent: a STOP is
 * acknowledged once by the roster flow, and nothing more is said. A database without the
 * table has nothing to cancel, and says so by name rather than failing the STOP.
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
    closed = await database
      .update(schema.groupReminders)
      .set({
        status: 'cancelled',
        statusReason: input.reason,
        what: null,
        closedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.groupReminders.chatId, input.chatId),
          inArray(schema.groupReminders.status, ['pending', 'scheduled']),
          scope,
        ),
      )
      .returning();
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    console.warn({ outcome: 'not_migrated' }, 'group reminders: table missing, nothing cancelled');
    return 'not_migrated';
  }
  await auditCancelled(database, closed, input.reason, 'system');
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
    and(eq(schema.groupReminders.status, 'sending'), lt(schema.groupReminders.updatedAt, stale)),
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

/** Takes one due reminder for this tick. Null: another tick, a STOP or a cancel got it first. */
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

/** Closes a claimed reminder as sent, dropped or failed, and audits it. */
export async function closeReminder(
  database: Database,
  row: Pick<GroupReminderRow, 'id' | 'familyId' | 'askedByUserId' | 'delivery'>,
  input: {
    status: 'sent' | 'dropped' | 'failed';
    reason: string | null;
    now: Date;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  await database
    .update(schema.groupReminders)
    .set({
      status: input.status,
      statusReason: input.reason,
      what: null,
      closedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(schema.groupReminders.id, row.id), eq(schema.groupReminders.status, 'sending')));
  const audit = {
    familyId: row.familyId,
    actor: 'system',
    targetTable: 'group_reminders',
    targetId: row.id,
    after: { delivery: row.delivery, reason: input.reason, ...input.after },
  };
  switch (input.status) {
    case 'sent':
      await database
        .insert(schema.auditLog)
        .values({ ...audit, actionTaken: 'group_reminder_sent' });
      return;
    case 'dropped':
      await database
        .insert(schema.auditLog)
        .values({ ...audit, actionTaken: 'group_reminder_dropped' });
      return;
    case 'failed':
      await database
        .insert(schema.auditLog)
        .values({ ...audit, actionTaken: 'group_reminder_failed' });
      return;
  }
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

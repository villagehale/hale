import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { isUndefinedTable } from '~/lib/channel/linq/roster';

/**
 * VIL-448 (T26) — the `group_reminders` rows: set, armed, cancelled, claimed and closed.
 *
 * Every state change is one guarded UPDATE, so two ticks or a STOP racing a send cannot
 * both win. A tick's claim is the `updated_at` it stamped: once a STOP, a cancel or a
 * later tick has taken the row, the tick's close and its check before sending both find
 * the claim gone and do nothing. Every close clears `what`, the member's own words, and
 * only a close that happened writes an audit row.
 */

/** A `sending` claim older than this is a tick that died or failed mid-send; it may be taken again. */
export const SENDING_STALE_MS = 10 * 60_000;
export const DUE_BATCH = 25;

/** Not sent yet, so a cancel or a STOP still wins, even over a tick that has claimed it. */
const CANCELLABLE: schema.GroupReminderStatus[] = ['pending', 'scheduled', 'sending'];

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
      .where(
        and(
          inArray(schema.groupReminders.id, input.ids),
          inArray(schema.groupReminders.status, CANCELLABLE),
        ),
      )
      .returning();
    await auditCancelled(tx, closed, input.reason, input.actor);
    return closed;
  });
}

/**
 * STOP works per member. A member who stops Hale in the group, or is taken out of the
 * chat, loses every unsent reminder they asked for and every one that is for them,
 * including one a tick is sending right now. Hale leaving the group (`phoneHash` absent)
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
        .where(
          and(
            eq(schema.groupReminders.chatId, input.chatId),
            inArray(schema.groupReminders.status, CANCELLABLE),
            scope,
          ),
        )
        .returning();
      await auditCancelled(tx, rows, input.reason, 'system');
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

function heldClaim(claim: Claim) {
  return and(
    eq(schema.groupReminders.id, claim.id),
    eq(schema.groupReminders.status, 'sending'),
    eq(schema.groupReminders.updatedAt, claim.updatedAt),
  );
}

/** The tick still holds this claim: no STOP, cancel or later tick has taken the row since. */
export async function claimHeld(database: Database, claim: Claim): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.groupReminders.id })
    .from(schema.groupReminders)
    .where(heldClaim(claim))
    .limit(1);
  return Boolean(row);
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

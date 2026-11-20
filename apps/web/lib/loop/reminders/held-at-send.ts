import { type Database, schema } from '@hale/db';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import {
  type DispatchPorts,
  type DispatchResult,
  PARENT_WINDOW_HOLD,
  PROACTIVE_FLOOR_HOLD,
  dispatchLoopMessage,
  recordAbandonedDispatch,
} from '~/lib/channel/dispatch';
import { SENT_STATUSES, dedupeActive } from '~/lib/channel/ledger';
import { textDedupeKey } from '~/lib/channel/outbound-transport';
import type { LoopMessage } from '~/lib/channel/types';
import type { OpsPager, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import {
  type DropReason,
  REMINDER_OFFSETS,
  type ReminderOffset,
  SEND_FAILED_HELD,
  SEND_PENDING,
  nextComposeHold,
} from './schedule';

/**
 * VIL-562 · a reminder the dispatch held for quiet hours goes back to the run.
 * VIL-730 · and every other send outcome settles the run's rows here too.
 *
 * The run leaves its rows 'scheduled' under the SEND_PENDING mark when it enqueues; a row
 * is 'sent' only once a ledger row Linq accepted exists for the leg (settleReminderSend).
 * A refused send (a gate such as `unbacked_claim`, a Linq refusal, a dead-lettered job)
 * puts the rows back to the run under the bounded backoff, and the last try drops them and
 * pages #ops. Nothing is ever sent in place of the model's text.
 *
 * A quiet hold returns the rows to plain 'scheduled', so the run's own rules decide at the
 * next slot: re-offered and re-composed once the floor opens before the event, dropped as
 * 'quiet_hours' or 'started' otherwise. No timing is decided here.
 */

export type ReminderSendHold =
  | { outcome: 'not_held' }
  | { outcome: 'released'; reminders: number }
  /** Part of the reminder already reached the parent; the rest is not offered again. */
  | { outcome: 'started_set' }
  /** A quiet hold with no named window: only the unreachable transport-held branch. */
  | { outcome: 'hold_unnamed' }
  | { outcome: 'payload_unreadable' };

const holdReason = z.enum([PROACTIVE_FLOOR_HOLD, PARENT_WINDOW_HOLD]);

const heldPayload = z.object({
  offset: z.enum(REMINDER_OFFSETS as [ReminderOffset, ...ReminderOffset[]]),
  events: z.array(z.object({ eventRef: z.string().uuid() })).min(1),
});

export async function releaseHeldReminder(
  database: Database,
  message: LoopMessage,
  result: DispatchResult,
): Promise<ReminderSendHold> {
  if (message.category !== 'reminder') return { outcome: 'not_held' };
  const leg = result.legs.find((l) => l.outcome === 'suppressed_quiet_hours');
  if (!leg) return { outcome: 'not_held' };

  const reason = holdReason.safeParse(leg.reason);
  if (!reason.success) {
    console.error(
      { code: 'hold_unnamed', familyId: message.familyId },
      'reminder: quiet hold with no named window, rows left pending',
    );
    return { outcome: 'hold_unnamed' };
  }
  const payload = heldPayload.safeParse(message.payload);
  if (!payload.success || !message.dedupeKey) {
    console.error(
      { code: 'payload_unreadable', familyId: message.familyId },
      'reminder: held payload unreadable, rows left pending',
    );
    return { outcome: 'payload_unreadable' };
  }

  const legKey = `${message.dedupeKey}:${leg.channel}`;
  if (
    (await dedupeActive(legKey, database)) ||
    (await dedupeActive(textDedupeKey(legKey, 0), database))
  ) {
    console.warn(
      { familyId: message.familyId, offset: payload.data.offset },
      'reminder: held after part of it was sent, the rest is not offered again',
    );
    const target = targetOf(message, payload.data);
    const delivered = await deliveredRow(database, legKey);
    await markPendingSent(database, target, delivered?.id ?? null);
    return { outcome: 'started_set' };
  }

  const { offset } = payload.data;
  const refs = payload.data.events.map((e) => e.eventRef);
  const released = await database.transaction(async (tx) => {
    const rows = await tx
      .update(schema.eventReminders)
      .set({
        status: 'scheduled',
        suppressReason: null,
        composeNextTryAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.eventReminders.familyId, message.familyId),
          eq(schema.eventReminders.parentUserId, message.parentUserId),
          eq(schema.eventReminders.offset, offset),
          inArray(schema.eventReminders.eventRef, refs),
          eq(schema.eventReminders.status, 'scheduled'),
          eq(schema.eventReminders.suppressReason, SEND_PENDING),
        ),
      )
      .returning({ id: schema.eventReminders.id });
    for (const row of rows) {
      await tx.insert(schema.auditLog).values({
        familyId: message.familyId,
        actor: 'system',
        actionTaken: 'reminder_held_at_send',
        targetTable: 'event_reminders',
        targetId: row.id,
        after: { offset, reason: reason.data },
      });
    }
    return rows.length;
  });
  console.info(
    { released, offset, reason: reason.data },
    'reminder: held at send, back to the run',
  );
  return { outcome: 'released', reminders: released };
}

/** The rows one reminder job carries: the run enqueued exactly these. */
interface PendingTarget {
  familyId: string;
  parentUserId: string;
  offset: ReminderOffset;
  refs: string[];
}

function targetOf(message: LoopMessage, payload: z.infer<typeof heldPayload>): PendingTarget {
  return {
    familyId: message.familyId,
    parentUserId: message.parentUserId,
    offset: payload.offset,
    refs: payload.events.map((e) => e.eventRef),
  };
}

/** Only the rows still under this job's SEND_PENDING mark: a row the run, an untrack or a
 * cancel has since moved on is not this settle's to touch. */
function pendingRows(target: PendingTarget) {
  return and(
    eq(schema.eventReminders.familyId, target.familyId),
    eq(schema.eventReminders.parentUserId, target.parentUserId),
    eq(schema.eventReminders.offset, target.offset),
    inArray(schema.eventReminders.eventRef, target.refs),
    eq(schema.eventReminders.suppressReason, SEND_PENDING),
  );
}

/**
 * The first ledger row Linq ACCEPTED under this leg's key: the single text's row
 * (`<legKey>`) or any text of a set (`<legKey>:<i>`). Accepted means a status in
 * SENT_STATUSES, which the dispatch writes only from the provider's own 'sent' answer.
 * A 'failed' row never counts, even though it consumes the key.
 */
async function deliveredRow(database: Database, legKey: string): Promise<{ id: string } | null> {
  const prefix = `${legKey}:`;
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        or(
          eq(schema.channelMessages.dedupeKey, legKey),
          sql`left(${schema.channelMessages.dedupeKey}, ${prefix.length}) = ${prefix}`,
        ),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt))
    .limit(1);
  return row ?? null;
}

async function markPendingSent(
  database: Database,
  target: PendingTarget,
  channelMessageId: string | null,
): Promise<number> {
  const rows = await database
    .update(schema.eventReminders)
    .set({
      status: 'sent',
      suppressReason: null,
      composeNextTryAt: null,
      channelMessageId,
      updatedAt: new Date(),
    })
    .where(pendingRows(target))
    .returning({ id: schema.eventReminders.id });
  return rows.length;
}

export type ReminderSendSettle =
  | ReminderSendHold
  /** Linq accepted it: the rows are 'sent', linked to the ledger row. */
  | { outcome: 'delivered'; reminders: number }
  /** Refused; back to the run under the bounded backoff, the failure named on the audit. */
  | { outcome: 'retrying'; reminders: number; reason: string }
  /** Refused on its last try: dropped as 'send_retries_exhausted' and #ops paged. */
  | { outcome: 'exhausted'; reminders: number; reason: string; page: OpsPagerOutcome | null }
  /** The parent's own pref or consent stopped it at send: dropped with that reason. */
  | { outcome: 'dropped'; reminders: number; reason: DropReason };

/** The closed list the #ops page may carry, never a provider's own code. */
function pageReason(
  reason: string,
): 'claim_gate' | 'send_refused' | 'send_abandoned' | 'not_confirmed' {
  if (reason === 'unbacked_claim' || reason === 'claim_read_failed') return 'claim_gate';
  if (reason === SEND_RETRIES_EXHAUSTED) return 'send_abandoned';
  if (reason === 'not_confirmed') return 'not_confirmed';
  return 'send_refused';
}

function defaultPager(database: Database): OpsPager {
  return {
    async page(page) {
      const { pageOps } = await import('~/lib/monitoring/failure-page');
      return pageOps(database, page);
    },
  };
}

async function dropPending(
  database: Database,
  target: PendingTarget,
  reason: DropReason,
  extra: Record<string, unknown> = {},
): Promise<number> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .update(schema.eventReminders)
      .set({
        status: 'suppressed',
        suppressReason: reason,
        composeNextTryAt: null,
        updatedAt: new Date(),
      })
      .where(and(pendingRows(target), eq(schema.eventReminders.status, 'scheduled')))
      .returning({ id: schema.eventReminders.id });
    for (const row of rows) {
      await tx.insert(schema.auditLog).values({
        familyId: target.familyId,
        actor: 'system',
        actionTaken: 'reminder_suppressed',
        targetTable: 'event_reminders',
        targetId: row.id,
        after: { reason, offset: target.offset, ...extra },
      });
    }
    return rows.length;
  });
}

/**
 * The send did not reach the parent. Each row goes back to the run under the SAME bounded
 * backoff a writer outage uses (nextComposeHold), so the next try is a fresh model compose
 * through every gate again; the last try drops it and pages #ops. Nothing is sent instead.
 */
async function holdFailedSend(
  database: Database,
  target: PendingTarget,
  reason: string,
  pager: OpsPager,
  now: Date,
): Promise<ReminderSendSettle> {
  const { held, exhausted } = await database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.eventReminders.id, attempts: schema.eventReminders.composeAttempts })
      .from(schema.eventReminders)
      .where(and(pendingRows(target), eq(schema.eventReminders.status, 'scheduled')));
    let held = 0;
    let exhausted = 0;
    for (const row of rows) {
      const step = nextComposeHold(row.attempts, now);
      if (step.action === 'exhausted') {
        await tx
          .update(schema.eventReminders)
          .set({
            status: 'suppressed',
            suppressReason: 'send_retries_exhausted' satisfies DropReason,
            composeNextTryAt: null,
            updatedAt: now,
          })
          .where(eq(schema.eventReminders.id, row.id));
        await tx.insert(schema.auditLog).values({
          familyId: target.familyId,
          actor: 'system',
          actionTaken: 'reminder_suppressed',
          targetTable: 'event_reminders',
          targetId: row.id,
          after: { reason: 'send_retries_exhausted', offset: target.offset, failure: reason },
        });
        exhausted += 1;
        continue;
      }
      await tx
        .update(schema.eventReminders)
        .set({
          status: 'scheduled',
          suppressReason: SEND_FAILED_HELD,
          composeAttempts: step.attempts,
          composeNextTryAt: step.nextTryAt,
          updatedAt: now,
        })
        .where(eq(schema.eventReminders.id, row.id));
      await tx.insert(schema.auditLog).values({
        familyId: target.familyId,
        actor: 'system',
        actionTaken: 'reminder_send_failed',
        targetTable: 'event_reminders',
        targetId: row.id,
        after: { reason, offset: target.offset, attempts: step.attempts },
      });
      held += 1;
    }
    return { held, exhausted };
  });

  console.error(
    { familyId: target.familyId, offset: target.offset, reason, held, exhausted },
    'reminder: send refused, not sent - back to the run',
  );
  if (exhausted === 0) return { outcome: 'retrying', reminders: held, reason };
  const page = await pager.page({
    site: 'reminder_unsent',
    facts: { reason: pageReason(reason) },
    count: exhausted,
  });
  return { outcome: 'exhausted', reminders: exhausted, reason, page };
}

/**
 * VIL-730 · settles the run's SEND_PENDING rows from what the dispatch did. A reminder is
 * 'sent' only on a ledger row Linq accepted; every other outcome leaves it unsent, and a
 * refusal is retried (bounded) rather than recorded as a send.
 */
export async function settleReminderSend(
  database: Database,
  message: LoopMessage,
  result: DispatchResult,
  pager: OpsPager = defaultPager(database),
  now: Date = new Date(),
): Promise<ReminderSendSettle> {
  if (message.category !== 'reminder') return { outcome: 'not_held' };
  const leg = result.legs[0];
  if (!leg) return { outcome: 'not_held' };
  if (leg.outcome === 'suppressed_quiet_hours') {
    return releaseHeldReminder(database, message, result);
  }
  const payload = heldPayload.safeParse(message.payload);
  if (!payload.success || !message.dedupeKey) {
    console.error(
      { code: 'payload_unreadable', familyId: message.familyId },
      'reminder: payload unreadable at settle, rows left pending until their lease',
    );
    return { outcome: 'payload_unreadable' };
  }
  const target = targetOf(message, payload.data);

  if (leg.outcome === 'suppressed_pref' || leg.outcome === 'suppressed_consent') {
    const reason: DropReason =
      leg.outcome === 'suppressed_pref' ? 'send_suppressed_pref' : 'send_suppressed_consent';
    return { outcome: 'dropped', reminders: await dropPending(database, target, reason), reason };
  }

  const legKey = `${message.dedupeKey}:${leg.channel}`;
  const delivered = await deliveredRow(database, legKey);
  if (delivered) {
    if (leg.outcome === 'failed') {
      // Part of a set already reached the parent: re-composing would repeat it.
      console.warn(
        { familyId: target.familyId, offset: target.offset, reason: leg.reason },
        'reminder: a later text of the set failed after one was accepted, not offered again',
      );
    }
    return {
      outcome: 'delivered',
      reminders: await markPendingSent(database, target, delivered.id),
    };
  }
  // A 'sent' or 'deduped' leg with no accepted row is not a send this code can stand on.
  const reason = leg.outcome === 'failed' ? (leg.reason ?? 'unknown') : 'not_confirmed';
  return holdFailedSend(database, target, reason, pager, now);
}

/** The drain's channel-send handler: the dispatch, then the reminder rows settle from it. */
export async function dispatchAndReleaseHold(
  database: Database,
  message: LoopMessage,
  ports: DispatchPorts,
  pager?: OpsPager,
): Promise<ReminderSendSettle> {
  const result = await dispatchLoopMessage(message, ports);
  return settleReminderSend(database, message, result, pager, ports.now());
}

/** The drain's dead-letter handler: the abandoned send's failed row, then the reminder rows
 * go back to the run (or, on their last try, are dropped and paged). */
export async function abandonAndSettleReminder(
  database: Database,
  message: LoopMessage,
  ports: DispatchPorts,
  pager?: OpsPager,
): Promise<ReminderSendSettle> {
  const result = await recordAbandonedDispatch(message, ports);
  return settleReminderSend(database, message, result, pager, ports.now());
}

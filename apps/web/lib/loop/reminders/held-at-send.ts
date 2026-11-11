import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  type DispatchPorts,
  type DispatchResult,
  PARENT_WINDOW_HOLD,
  PROACTIVE_FLOOR_HOLD,
  dispatchLoopMessage,
} from '~/lib/channel/dispatch';
import { dedupeActive } from '~/lib/channel/ledger';
import { textDedupeKey } from '~/lib/channel/outbound-transport';
import type { LoopMessage } from '~/lib/channel/types';
import { REMINDER_OFFSETS, type ReminderOffset } from './schedule';

/**
 * VIL-562 · a reminder the dispatch held for quiet hours goes back to the run.
 *
 * The run marks its rows 'sent' the moment it enqueues, before any send exists. When the
 * send is then held (a retry or a drain backlog carried it past the floor), those rows
 * would claim a text that never left, and nothing would offer it again. This returns
 * them to 'scheduled', so the run's own rules decide at the next slot: re-offered and
 * re-composed once the floor opens before the event, dropped as 'quiet_hours' or
 * 'started' otherwise. No timing is decided here.
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
      'reminder: quiet hold with no named window, rows left as sent',
    );
    return { outcome: 'hold_unnamed' };
  }
  const payload = heldPayload.safeParse(message.payload);
  if (!payload.success || !message.dedupeKey) {
    console.error(
      { code: 'payload_unreadable', familyId: message.familyId },
      'reminder: held payload unreadable, rows left as sent',
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
    return { outcome: 'started_set' };
  }

  const { offset } = payload.data;
  const refs = payload.data.events.map((e) => e.eventRef);
  const released = await database.transaction(async (tx) => {
    const rows = await tx
      .update(schema.eventReminders)
      .set({ status: 'scheduled', suppressReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.eventReminders.familyId, message.familyId),
          eq(schema.eventReminders.parentUserId, message.parentUserId),
          eq(schema.eventReminders.offset, offset),
          inArray(schema.eventReminders.eventRef, refs),
          eq(schema.eventReminders.status, 'sent'),
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

/** The drain's channel-send handler: the dispatch, then a held reminder goes back to the run. */
export async function dispatchAndReleaseHold(
  database: Database,
  message: LoopMessage,
  ports: DispatchPorts,
): Promise<ReminderSendHold> {
  return releaseHeldReminder(database, message, await dispatchLoopMessage(message, ports));
}

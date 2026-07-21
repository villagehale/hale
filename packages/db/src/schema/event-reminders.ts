import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { reminderStatusEnum } from './enums.js';
import { families } from './families.js';
import { familyEvents } from './family-events.js';
import { users } from './users.js';

/**
 * F11 · The Sunday Loop — event_reminders (VIL-223 · D1). The materialized reminder
 * ledger over PLACED calendar items (family_events). One row per (event, offset,
 * parent) — the T-24h "evening before" and the T-1h day-of ping.
 *
 * Why materialized (not computed-at-send): cancellation must be EXPLICIT and auditable
 * (rule #6), same-evening reminders must be batchable (they need to be enumerable), and
 * suppressions carry a logged reason. The hourly scheduler CONVERGES this ledger to the
 * set derived from live family_events each tick — a move re-anchors `fire_at` via the
 * (event_ref, fire_offset, parent_user_id) upsert, a soft-deleted event's rows go
 * 'cancelled' — and every send is re-gated on a fresh read of the live event, so a
 * cancelled/moved event can never fire regardless of whether the recompute hook ran.
 *
 * The unique (event_ref, fire_offset, parent_user_id) is both the convergence upsert
 * anchor AND the per-(event,offset,parent) dedupe; A2 suffixes the channel at dispatch.
 * `fire_offset` (not `offset`, a SQL reserved word) stores the ISO-8601 duration so the
 * offset set stays extensible.
 */
export const eventReminders = pgTable(
  'event_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The placed family_events row this reminds about; cascades if the event is hard-
     * deleted (a soft-delete just flips family_events.deleted_at → 'cancelled' here). */
    eventRef: uuid('event_ref')
      .notNull()
      .references(() => familyEvents.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ISO-8601 duration before starts_at: '-P1D' (evening-before) | '-PT1H' (day-of). */
    offset: text('fire_offset').notNull(),
    /** Materialized fire instant (family-local computed); re-anchored on a move. */
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: reminderStatusEnum('status').notNull().default('scheduled'),
    /** Why a non-firing terminal status was reached (a suppress reason / 'moved'), for
     * the audit trail — null while 'scheduled' or after a clean 'sent'. */
    suppressReason: text('suppress_reason'),
    /** The A2 channel_messages row minted when this reminder was dispatched. */
    channelMessageId: uuid('channel_message_id').references(() => channelMessages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped whenever the scheduler re-anchors fire_at or transitions status. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One reminder per (event, offset, parent) — the convergence upsert anchor + the
    // per-(event,offset,parent) dedupe (A2 adds the channel suffix at dispatch).
    eventOffsetParentUniq: uniqueIndex('event_reminders_event_offset_parent_uniq').on(
      table.eventRef,
      table.offset,
      table.parentUserId,
    ),
    // The scheduler's due scan: WHERE status = 'scheduled' AND fire_at <= now.
    dueIdx: index('event_reminders_due_idx').on(table.status, table.fireAt),
  }),
);

export type EventReminder = typeof eventReminders.$inferSelect;
export type NewEventReminder = typeof eventReminders.$inferInsert;

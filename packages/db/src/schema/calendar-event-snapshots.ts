import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { integrations } from './integrations.js';

/**
 * What the calendar alert last KNEW about one event on one connection.
 *
 * The connector sweep is a delta reader: `events.list` hands back a change once and the
 * syncToken advances past it the same instant. Everything the alert path could not answer
 * from a single change in isolation was therefore unanswerable — three follow-ups off
 * #650, all of them the same missing memory:
 *
 *   MOVED  — a changed event read "X is on your calendar for <new time>", because nothing
 *            held the OLD time to say it moved from.
 *   SERIES — with `singleEvents=true` one edit to a weekly class arrives as one change per
 *            instance; without `recurring_event_id` in hand there was nothing to group on,
 *            so one edit spent the whole per-sweep budget on itself.
 *   HELD   — a change refused by quiet hours or the frequency cap was never offered again,
 *            because the token had moved and nothing remembered Hale still owed the text.
 *
 * WHAT IT MAY HOLD (rule #1). The calendar belongs to the parent and its description and
 * attendee list never enter Hale at all. This table holds the SHAPE of an event — when it
 * is, whether it is all-day, which series it belongs to — plus, for as long as a text is
 * owed and not one sweep longer, the two strings the alert had already decided it was
 * willing to say out loud: the clamped title and the vetted location. Both are cleared the
 * moment the hold resolves, so the steady state of this table carries no parent words at
 * all. Deleting the integration (and so the family) takes the rows with it.
 */
export const calendarEventSnapshots = pgTable(
  'calendar_event_snapshots',
  {
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** Google's `id` for this event or, with `singleEvents=true`, for this INSTANCE. */
    eventId: text('event_id').notNull(),
    /** The series this instance belongs to, or null for a one-off. The grouping key that
     * turns six instance changes into one text. */
    recurringEventId: text('recurring_event_id'),
    /** The start the parent was last told about — the only thing that can make the next
     * sighting a MOVE rather than a first sight. Null only for a shape nothing could
     * place. */
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    allDay: boolean('all_day').notNull().default(false),
    /** Google's `updated` (or the etag the sync fell back to) at the last sighting. */
    updatedStamp: text('updated_stamp').notNull(),
    /** `confirmed` | `tentative` | `cancelled`, as the alert path narrows it. */
    status: text('status').notNull(),
    /** Set when a change was held by the outbound gate or by the per-sweep cap, and kept
     * at its ORIGINAL instant across later holds so the re-offer order is the order the
     * texts were owed in. Cleared by a send, a drop or an expiry. */
    pendingSince: timestamp('pending_since', { withTimezone: true }),
    /** Everything a re-offer needs to say the same sentence again. The title and the
     * location are the ONLY parent-authored content this table ever holds, already clamped
     * and vetted by the renderer — a mailbox or a pasted address never reaches here,
     * because it never reached the text either. `heldMovedFromAt` is the start the held
     * text said the event moved FROM, so a move refused at 11 p.m. is still a move at 8
     * a.m. rather than a bare "is on your calendar". All three are null unless a text is
     * owed, and the table's CHECK is what makes that a fact rather than a habit. */
    heldTitle: text('held_title'),
    heldLocation: text('held_location'),
    heldMovedFromAt: timestamp('held_moved_from_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.integrationId, table.eventId] }),
    // The re-offer's whole working set, in the order it owes them. Partial, so in a
    // healthy system this index holds nothing at all.
    pendingIdx: index('calendar_event_snapshots_pending_idx')
      .on(table.integrationId, table.pendingSince)
      .where(sql`${table.pendingSince} IS NOT NULL`),
  }),
);

export type CalendarEventSnapshot = typeof calendarEventSnapshots.$inferSelect;
export type NewCalendarEventSnapshot = typeof calendarEventSnapshots.$inferInsert;

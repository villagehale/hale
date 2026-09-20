import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * THE BOOKING A CONFIRMATION RECORDS — the family holds a place, and Hale may check back.
 *
 * WHY THIS TABLE EXISTS AT ALL. There is no `family_events.source` value that gets the
 * reminders, the weekly plan and the "how did it go?" ask at once: the reminder converger
 * reads `placement`+`parent`, the weekly composer reads everything but `placement`, and
 * the follow-up sweep reads `placement` only. A sixth enum value would be wrong for the
 * reason the follow-up's own comment gives — the other sources are occasions the family
 * told Hale ABOUT, and checking back on one is Hale asking about a family's life for no
 * reason it can name. The missing primitive is the BOOKING: "may Hale ask how it went?"
 * is a fact about the booking, not about who authored the calendar row.
 *
 * WHY NOT A COLUMN ON `family_events`. A booking exists before any calendar row does and
 * survives a parent who never answers the offer, so it cannot live on a row that only
 * exists after a YES. And `family_events` has five readers; a provider host and a parent
 * id on it widens all five for one feature's benefit.
 *
 * WHY NOT `agent_commitments`. `agent_commitments_open_kind_uniq` permits ONE open promise
 * of a kind per family while a household books two classes in a September week — the wall
 * `watched_spots` and `email_alert_offers` both hit. And nothing here was promised out
 * loud, which is what that ledger records.
 *
 * WHAT IT MAY HOLD (rule #1). The extraction's own title, its own instant, its own place,
 * and the sender's bare domain. Never the subject line, never the snippet, never the quote
 * evidence. Confirmation numbers, order ids, amounts and child names have NO COLUMN and
 * are therefore unwritable. A 13+ child's confirmation writes NO ROW AT ALL: the pipeline
 * has genericised the title by the time the alert path sees it, so recording it would let
 * a follow-up ask about a teen's activity four days later on the strength of a title Hale
 * deliberately erased.
 *
 * NO STATUS COLUMN, following `watched_spots` and `registration_sequences`. "Is the
 * follow-up still due" is a query; "is it on the calendar" is `event_id IS NOT NULL`.
 *
 * Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
 * one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
 */
export const activityBookings = pgTable(
  'activity_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /**
     * WHOSE MAILBOX THIS CAME FROM, and therefore WHOSE PHONE the follow-up goes to.
     *
     * The privacy field, not a convenience one. The alert texts the CONNECTING user and
     * the offer is answerable only by them; a co-parent's Gmail producing a question on
     * the primary parent's phone four days later is a crossing neither parent consented to
     * (rule #5, D13), about a registration the other may not know happened. Its own
     * cascade, because a co-parent who leaves the household is a row the family cascade
     * would not collect.
     */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * WHICH CONNECTION the email came through. Deliberately NO foreign key, the same call
     * `email_alert_offers.integration_id` and the two `created_from` columns make: a
     * parent who disconnects Gmail still went to the class.
     */
    integrationId: uuid('integration_id').notNull(),
    /** The provider's own message id. With the connection, the identity of the booking. */
    messageId: text('message_id').notNull(),
    /**
     * The bare DOMAIN of the confirming sender. Provenance, and the only stable non-title
     * identity a later review pool could aggregate on. Never the display name, never the
     * local part, never the full address — and never copied into `audit_log`, whose row
     * for this write carries one boolean. This is the single place it lives.
     */
    providerHost: text('provider_host').notNull(),
    /** The extraction's own title, through the same fold the wire uses. */
    title: text('title').notNull(),
    /** The FIRST session. v1 records one instant; the recurring series is a later
     * ticket, and `civic_sessions` already exists for that job. */
    firstSessionAt: timestamp('first_session_at', { withTimezone: true }).notNull(),
    location: text('location'),
    /**
     * The `family_events` row this booking is ON. ONE meaning, two writers: the
     * correlation stamps it at detection when the class is already on the calendar, and
     * the offer stamps it when the parent says yes. They cannot race — a booking that
     * correlated makes no offer — so at most one ever runs. No FK: a claim key, and both
     * tables cascade on family deletion.
     */
    eventId: uuid('event_id'),
    /**
     * The outbound row that told the parent. NOT NULL, because the booking is written
     * AFTER the transport accepted the text: a booking from a text that never went is a
     * fact Hale would act on a week later with nobody having been told.
     */
    channelMessageId: uuid('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One booking per email, as a constraint rather than a convention — and the key
    // `stampBookingEvent` addresses a row by, so the offer and the booking need no third
    // id threaded between them.
    messageUniq: uniqueIndex('activity_bookings_message_uniq').on(
      table.integrationId,
      table.messageId,
    ),
    // The follow-up reader's working set. Plain, not partial: the window is relative to
    // `now`, so there is no constant predicate to make it partial with.
    dueIdx: index('activity_bookings_due_idx').on(table.familyId, table.firstSessionAt),
  }),
);

export type ActivityBooking = typeof activityBookings.$inferSelect;
export type NewActivityBooking = typeof activityBookings.$inferInsert;

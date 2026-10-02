import { sql } from 'drizzle-orm';
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
     * THE SESSION, as one string — `provider_host`, the folded title and the first
     * instant, computed ONCE at write time by `lib/integrations/going.ts`'s `sessionKey`
     * and compared by plain equality. Stored rather than folded in the read, because a
     * normalisation written in SQL beside the TypeScript copy that wrote the row is one
     * rule in two languages, and the day they disagree the count reads as an empty room.
     *
     * NULLABLE, and NULL is the only refusal this feature has: a fallback title, a
     * freemail sender, or a title that folds to nothing. A NULL-keyed booking is a real
     * booking whose follow-up still asks — it is simply not countable in EITHER
     * direction, and it is never counted about either.
     *
     * It discloses nothing new: all three parts are already columns on this row.
     */
    sessionKey: text('session_key'),
    /**
     * THE CLASS, as one string — sender domain, canonical title, and the UTC date of the
     * first session. Written by `bookingDedupeKey` so a second email about the same class
     * (an invoice, then the receipt) updates this row instead of inserting another.
     *
     * NULLABLE. A row written before the column existed has no key, and the readers
     * recompute the same function from the columns rather than trusting a missing one.
     * NULL is not unique: Postgres treats nulls as distinct, so a backfill that cannot
     * prove two legacy rows are the same class does not have to delete one of them.
     *
     * It discloses nothing new. The three parts are already columns on this row.
     */
    dedupeKey: text('dedupe_key'),
    /**
     * THE PROVIDER CALLED IT OFF — set when a later email from the same `provider_host`
     * cancels the same class, and the follow-up reader's `IS NULL`.
     *
     * Not a status column and not the one the table's own note rules out: "is the follow-up
     * still due" is still a query. This records a FACT the provider stated, the way
     * `event_id` records one the parent stated, and an instant rather than a boolean
     * because when a booking stopped being real is what a support agent is asked.
     */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * The `family_events` row this booking is ON. ONE meaning, two writers: the
     * correlation stamps it at detection when the class is already on the calendar, and
     * the offer stamps it when the parent says yes. They cannot race — a booking that
     * correlated makes no offer — so at most one ever runs. No FK: a claim key, and both
     * tables cascade on family deletion.
     */
    eventId: uuid('event_id'),
    /**
     * The outbound row that told the parent, when a text went out.
     *
     * Live detection writes this AFTER the transport accepted the text. NULL is the
     * booked-detection backfill (`0151_activity_bookings_backfill_channel`): mail that
     * arrived before Gmail was connected is recorded without a text, an offer, or an
     * `email_alert_sent` audit. The later follow-up ask is what the parent hears. A
     * live alert still passes a real id.
     */
    channelMessageId: uuid('channel_message_id').references(() => channelMessages.id, {
      onDelete: 'cascade',
    }),
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
    // One LIVE class per family. A cancelled booking drops out of the predicate so a
    // later re-registration of the same class can be written. Partial, and null keys
    // are not covered — see `dedupe_key`.
    dedupeUniq: uniqueIndex('activity_bookings_dedupe_uniq')
      .on(table.familyId, table.dedupeKey)
      .where(sql`${table.cancelledAt} IS NULL AND ${table.dedupeKey} IS NOT NULL`),
    // The follow-up reader's working set. Plain, not partial: the window is relative to
    // `now`, so there is no constant predicate to make it partial with.
    dueIdx: index('activity_bookings_due_idx').on(table.familyId, table.firstSessionAt),
    // The count reads ACROSS families on one key, so the due index above cannot serve it.
    // PARTIAL, because here there IS a constant predicate: a cancelled booking is never
    // counted by anybody.
    sessionIdx: index('activity_bookings_session_idx')
      .on(table.sessionKey)
      .where(sql`${table.cancelledAt} IS NULL`),
  }),
);

export type ActivityBooking = typeof activityBookings.$inferSelect;
export type NewActivityBooking = typeof activityBookings.$inferInsert;

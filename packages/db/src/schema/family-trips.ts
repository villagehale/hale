import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * A TRIP HALE NOTICED IN A BOOKING EMAIL, and may say one thing about a week before it.
 *
 * WHAT IS ABSENT IS THE POINT, and every absence is structural rather than remembered:
 *   · The email BODY, subject, snippet and sender have no column. The extractor holds the
 *     body in one stack frame and returns six scalars (sentinel/fetch-body.ts's
 *     BODY_RETENTION = 'transient-per-extraction-call'), so there is nowhere for any of
 *     them to land.
 *   · The confirmation / PNR number and the PRICE have no column, and the extraction
 *     schema gives the model no field to put one in.
 *   · The hotel, airline or host NAME has no column: it is the sender's identity plus a
 *     date, which is the disclosure renderEmailAlert already drops for a teen.
 *   · `child_id` has no column. The sentinel's own `childRef` is documented as suggestive
 *     and never a binding, so a stored child would hand the teen gate a guess. The names
 *     in the text come from a live `children` read at send time.
 *
 * AND THERE IS NO ROW AT ALL for a booking whose own text gives no sign the children are
 * on it. {@link CHILD_EVIDENCE} carries two values, not three: a solo work trip's
 * destination and dates are a fact with no purpose Hale could name (PIPEDA), they would
 * sit in the due index forever, and they are the single row a requester-scoped export
 * would otherwise hand a co-parent. The miss rate is an enum-only `travel_booking_passed_over`
 * audit row instead -- countable for a month, and carrying no city and no date.
 *
 * Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
 * one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
 */

/**
 * WHY HALE THINKS THE CHILDREN ARE ON THIS TRIP. A category, never the passenger line.
 *
 * `named_traveller` — a passenger or guest line matched a household child's first name.
 * `child_fare`      — the itinerary priced or counted a child or infant ("1 adult,
 *                     1 child", "INF", "Child (2-11)").
 *
 * There is deliberately no third member. A booking that says nothing about who is going
 * produces the detect outcome `no_child_evidence` and NO ROW, which is what makes "Hale
 * never briefs a solo work trip" a property of the schema rather than of a code path
 * somebody has to keep.
 */
export const CHILD_EVIDENCE = ['named_traveller', 'child_fare'] as const;
export type ChildEvidence = (typeof CHILD_EVIDENCE)[number];

/**
 * HOW A TRIP LEAVES THE WORKING SET — exactly once, for a reason that is written down.
 *
 * `sent`      — a text went out about it, carried by {@link familyTrips.briefChannelMessageId}.
 * `merged`    — it overlapped a trip that was briefed in the same tick (the flight and the
 *               hotel are two emails and one piece of news), and it shares that text's
 *               message id.
 * `overtaken` — `starts_on` passed while it was still open. It closes with a NULL message
 *               id, which the COALESCE'd CHECK permits and the other two forbid: a trip
 *               nobody was told about must never read as one they were.
 */
export const TRIP_CLOSED_REASONS = ['sent', 'merged', 'overtaken'] as const;
export type TripClosedReason = (typeof TRIP_CLOSED_REASONS)[number];

export const familyTrips = pgTable(
  'family_trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** WHOSE mailbox saw it, and whose phone and clock the brief uses. Its own cascade,
     * the email_alert_offers call: a departed co-parent's trips go with them. */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which connection the email came through, and with `message_id` the natural
     * identity of the trip. Deliberately NO foreign key, the same call 0116 makes: a
     * connection is not this row's lifecycle parent, and disconnecting Gmail must not
     * delete a trip that is still coming. */
    integrationId: uuid('integration_id').notNull(),
    /** The provider's own message id. */
    messageId: text('message_id').notNull(),
    /** A CITY, and at most a region beside it. Both have cleared `destinationShape` at
     * the parse boundary before they reach this table, because these are the only two
     * fields in the feature a model fills that are then persisted, exported and sent
     * across a border. */
    destinationCity: text('destination_city').notNull(),
    destinationRegion: text('destination_region'),
    /** LOCAL CALENDAR DAYS, not instants: "the 12th to the 15th" is a wall clock at the
     * destination, and a timestamptz would render it off the parent's zone. */
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    /** One of {@link CHILD_EVIDENCE}. */
    childEvidence: text('child_evidence').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** One of {@link TRIP_CLOSED_REASONS}, paired with `closed_at` by a CHECK. */
    closedReason: text('closed_reason'),
    /** The outbound row that carried the brief. Present exactly when the trip closed
     * `sent` or `merged`. */
    briefChannelMessageId: uuid('brief_channel_message_id').references(() => channelMessages.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One trip per email, as a constraint rather than a convention.
    messageUniq: uniqueIndex('family_trips_message_uniq').on(table.integrationId, table.messageId),
    // The send sweep's whole working set. Partial, and it really does empty: every row
    // closes for one of three named reasons.
    dueIdx: index('family_trips_due_idx')
      .on(table.startsOn)
      .where(sql`${table.closedAt} IS NULL`),
    childEvidenceCheck: check(
      'family_trips_child_evidence_check',
      sql`${table.childEvidence} IN ('named_traveller', 'child_fare')`,
    ),
    datesCheck: check('family_trips_dates_check', sql`${table.endsOn} >= ${table.startsOn}`),
    closedReasonCheck: check(
      'family_trips_closed_reason_check',
      sql`${table.closedReason} IS NULL OR ${table.closedReason} IN ('sent', 'merged', 'overtaken')`,
    ),
    closedCheck: check(
      'family_trips_closed_check',
      sql`(${table.closedAt} IS NULL) = (${table.closedReason} IS NULL)`,
    ),
    // COALESCE ON PURPOSE: a CHECK that evaluates to NULL passes in Postgres, so the
    // natural form is vacuously true on every open row and enforces nothing.
    briefMessageCheck: check(
      'family_trips_brief_message_check',
      sql`(${table.briefChannelMessageId} IS NOT NULL) = (COALESCE(${table.closedReason}, '') IN ('sent', 'merged'))`,
    ),
  }),
);

export type FamilyTrip = typeof familyTrips.$inferSelect;
export type NewFamilyTrip = typeof familyTrips.$inferInsert;

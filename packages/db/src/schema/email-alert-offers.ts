import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * THE OFFER A GMAIL ALERT MAKES, written down at send time.
 *
 * The alert text ends "Reply YES and it goes on your week." — and a sentence that invites
 * an acceptance is only honest if the acceptance has somewhere to land. It did not: the
 * first cut of that line shipped with nothing behind it, so a parent doing exactly what
 * the text said reached the coach with nothing drafted, or, with one unrelated action
 * pending, APPROVED THAT ONE (rule #4). The line was removed in #649 and this table is
 * what brings it back.
 *
 * WHY NOT `agent_commitments`, which is where every other standing offer lives. Two
 * reasons, both structural rather than stylistic:
 *   · `agent_commitments_open_kind_uniq` permits ONE open promise of a kind per family,
 *     while the outbound gate allows three email alerts a day — offers two and three
 *     would be unwritable. (`watched_spots` hit the same wall and made its own table.)
 *   · The row has to carry the OCCASION — a title, an instant, a place — and the ledger's
 *     `summary` is contractually one parent-safe sentence with `topic` a closed
 *     vocabulary. Neither can hold an event.
 *
 * WHAT IT MAY HOLD (rule #1). The extraction's own title, its own instant, its own place
 * — the same three facts the text already put on the parent's phone, sanitised by the
 * same fold the wire uses. Never the subject line, never the snippet, never the quote
 * evidence. A 13+ child's mail writes NO ROW AT ALL: the pipeline has genericised the
 * title by then, so there is no occasion left to add, and the absence of a row is the
 * absence of the offer.
 *
 * Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
 * one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
 */
export const emailAlertOffers = pgTable(
  'email_alert_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** WHO WAS ASKED. The offer was put to one parent's phone and only that parent has it
     * open — the same per-parent rule the intro opt-in and the co-parent scope question
     * keep, because a co-parent's "yes" answers a question nobody put to them. */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * WHICH CONNECTION the email came through. Provenance, and with `message_id` the
     * natural identity of the offer: one email is one offer, forever.
     *
     * Deliberately NO foreign key, the same call `agent_commitments.created_from` and
     * `watched_spots.created_from` make. A connection is not this row's lifecycle parent:
     * a parent who disconnects Gmail is still holding a text that asked them a question,
     * and a cascade here would delete the standing question out from under it. A
     * re-connected mailbox mints new ids and therefore new offers, exactly as the alert's
     * own dedupe key does.
     */
    integrationId: uuid('integration_id').notNull(),
    /** The provider's own message id. */
    messageId: text('message_id').notNull(),
    /** The extraction kind the alert was written from. An enum-shaped fact, for the audit
     * row and for reading the ledger back; never a sentence. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** The occasion's start INSTANT, exactly as it will be written to family_events. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    location: text('location'),
    /** The outbound row that carried the CTA. An offer nobody was told about is not an
     * offer (the MEM-10 send-time discipline), so this is NOT NULL and the row is written
     * after the transport has accepted the text. */
    channelMessageId: uuid('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    /** When the offer stops being answerable. Applied AT THE READER, so an expired offer
     * is never listed, never named in a clarifying sentence and never resolvable — the
     * discipline the plan, checkup and founder offers all keep. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * The family_events row this offer placed — CLAIMED BEFORE THE INSERT, so a turn that
     * added the event and then failed to answer is re-drivable without double-placing.
     * Deliberately no FK, the same reasoning `family_events.placed_by_action_id` states:
     * the stamp is a claim key, and both tables already cascade on family deletion.
     */
    eventId: uuid('event_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** 'added' | 'declined' — paired with `resolved_at` by a CHECK, because half a
     * resolution is an offer quietly deleted. */
    resolution: text('resolution'),
    /**
     * The RECEIPT: the outbound row that told the parent what their answer did.
     *
     * Paired with `resolved_at` by the same CHECK, because an offer is only ever closed
     * from `afterSend` — a turn that acted and never spoke leaves the question standing.
     * It is read for the LAST-WORD rule: a second "yes" is still about this offer only
     * while this message is the last thing Hale said to this parent, so a coach question
     * asked in between takes the word back (the registration ladder's own rule,
     * `readinessAskedLastAt`).
     */
    resolvedChannelMessageId: uuid('resolved_channel_message_id').references(
      () => channelMessages.id,
      { onDelete: 'cascade' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The reader's whole working set: this parent's open offers, newest first. Partial,
    // so in a healthy system it holds only the questions actually standing.
    openIdx: index('email_alert_offers_open_idx')
      .on(table.familyId, table.parentUserId, table.createdAt)
      .where(sql`${table.resolvedAt} IS NULL`),
    // One offer per email, as a constraint rather than a convention.
    messageUniq: uniqueIndex('email_alert_offers_message_uniq').on(
      table.integrationId,
      table.messageId,
    ),
    // A resolution is complete, named and carried by a message the parent got, or it did
    // not happen.
    resolutionCheck: check(
      'email_alert_offers_resolution_check',
      sql`(${table.resolvedAt} IS NULL) = (${table.resolution} IS NULL)
	AND (${table.resolvedAt} IS NULL) = (${table.resolvedChannelMessageId} IS NULL)
	AND (${table.resolution} IS NULL OR ${table.resolution} IN ('added', 'declined'))`,
    ),
  }),
);

export type EmailAlertOffer = typeof emailAlertOffers.$inferSelect;
export type NewEmailAlertOffer = typeof emailAlertOffers.$inferInsert;

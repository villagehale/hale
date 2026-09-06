import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * The three closed vocabularies behind this table's `text` columns, held against
 * migration 0109's CHECK constraints by
 * packages/db/scripts/watched-spots-vocabulary-consistency.test.mjs — the only gate that
 * reads the .sql against this file.
 */

/** What a TRUSTWORTHY read left behind. `unreadable` and `not_registrable` are readings,
 * never states: a page nobody could open says nothing about the class. */
export const WATCHED_SPOT_STATES = ['full', 'waitlist_full', 'open'] as const;
export type WatchedSpotState = (typeof WATCHED_SPOT_STATES)[number];

/** The two openings worth a text. A reopened waitlist is news of its own because it rests
 * in the same state ('full') as the class it opened on. */
export const WATCHED_SPOT_PENDING_KINDS = ['seat_opened', 'waitlist_reopened'] as const;
export type WatchedSpotPendingKind = (typeof WATCHED_SPOT_PENDING_KINDS)[number];

/** Every way a watch can end. Each one has a writer in the sweep, and each says something
 * different to a parent who asks why Hale stopped: `notified` kept it, `delivery_failed`
 * and `send_unconfirmed` did not. */
export const WATCHED_SPOT_RELEASE_REASONS = [
  'notified',
  'expired',
  'parent_stopped',
  'consent_withdrawn',
  'unreadable_streak',
  'registration_closed',
  'delivery_failed',
  'send_unconfirmed',
] as const;
export type WatchedSpotReleaseReason = (typeof WATCHED_SPOT_RELEASE_REASONS)[number];

/**
 * VIL-337 · WATCHED SPOTS — the course pages a family asked Hale to re-read for a way in.
 *
 * A parent pastes the link to a full class and asks to be told if a spot opens. That
 * sentence has nowhere to live today: `agent_commitments` permits ONE open promise of a
 * kind per family, so a household watching two classes cannot be two rows there, and
 * `registration_windows` is family-agnostic reference data keyed on a CYCLE with no
 * class-level identity — its cascade would delete a parent's watch when a window is
 * retired. So the WATCH is a row here and the PROMISE stays on the ledger.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - a status column. Live is `released_at IS NULL`; a held observation is
 *     `pending_kind IS NOT NULL`; a text awaiting its receipt is
 *     `notified_message_id IS NOT NULL`. Three nullable columns say everything a status
 *     could, and they cannot disagree with the thing they mirror.
 *   - a poll-run table. `cron_heartbeats` says the sweep FIRED; `max(last_polled_at)`
 *     says a spot was REACHED. A row per read would be a million rows a year saying
 *     what two clocks already say.
 *   - anything the parent wrote that was not gated. `source_url` is what
 *     `sanitizeSpotUrl` rebuilt (https, a registry host, the one course-page path, two
 *     GUID parameters) and `label` is what the activity lane's de-identifying gate let
 *     through unchanged. Neither is ever the raw tool input (rule #1).
 *
 * Family-scoped with a cascading FK, which IS the erasure path: `runDeletionSweep`
 * issues one DELETE FROM families and lets the cascade do the rest.
 */
export const watchedSpots = pgTable(
  'watched_spots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /**
     * The recipient the outbound gate is asked about. Its own cascade: a user removed
     * from a household is a row the family cascade would not collect.
     */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The page Hale re-reads, already sanitized when it gets here. Nothing else in this
     * product sends a parent-supplied URL to the network, so this column is the whole
     * trust boundary. With the family it is also the identity: on this portal one course
     * page is exactly one registrable event.
     */
    sourceUrl: text('source_url').notNull(),
    /** What the parent reads back — a few words for the class, refused rather than
     * rewritten if the de-identifying gate would have changed them. Never a household
     * member's name (rule #1). */
    label: text('label').notNull(),
    /** The explicit per-watch opt-in to hear at any hour. Read at send time to pick the
     * proactive CLASS, never to widen one. */
    instant: boolean('instant').notNull().default(false),
    /**
     * What the last TRUSTWORTHY read said. Always full or waitlist_full at birth: a watch
     * is only armed against a page that read that way in the same turn the parent asked.
     * A page nobody could read is NOT a state here — it is counted in
     * `consecutiveFailures` and changes nothing, because a page you could not open is not
     * a page that says the class is full.
     */
    lastState: text('last_state').$type<WatchedSpotState>().notNull().default('full'),
    /**
     * The observation Hale is holding and has not yet been allowed to say. Written by the
     * transition claim, cleared by a delivery receipt or by the page changing its mind
     * before the send. Explicit rather than derived, because a reopened waitlist rests in
     * the same state as a full class and could not be told apart otherwise.
     */
    pendingKind: text('pending_kind').$type<WatchedSpotPendingKind>(),
    pendingSince: timestamp('pending_since', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * The transition counter IS the idempotency anchor. Incremented by a guarded update
     * and carried in the send's dedupe key, so one opening is one text forever, and a
     * class that fills and frees again is a new key rather than a silenced one.
     */
    openTransitions: integer('open_transitions').notNull().default(0),
    /** Transitions the parent was CONFIRMED told about: advanced by a sent or delivered
     * receipt on the ledger row, never by the carrier merely accepting the message. */
    notifiedTransitions: integer('notified_transitions').notNull().default(0),
    /** The send claim and the retry bound in one counter: incremented by a guarded update
     * BEFORE the transport call, carried in the dedupe key, reset by each new
     * transition. */
    sendAttempts: integer('send_attempts').notNull().default(0),
    /** The `channel_messages` row of the latest attempt, whose delivery status decides
     * the release. Text provenance rather than a foreign key, on the same reasoning as
     * `agent_commitments.created_from`. */
    notifiedMessageId: text('notified_message_id'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    /** When this spot may next be read. Carries BACKOFF only: a healthy read leaves it
     * alone, so a tick that fires late still finds every live spot due. */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
    /** A watch stops being watched. Set at arming time; the sweep releases past it. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedReason: text('released_reason').$type<WatchedSpotReleaseReason>(),
    /** The `channel_messages` id of the outbound that carried the arming sentence — the
     * same send-time discipline as the open-loops ledger: a watch nobody was told about
     * is not a watch. Provenance only. */
    createdFrom: text('created_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateCheck: check(
      'watched_spots_state_check',
      sql`${table.lastState} IN ('full', 'waitlist_full', 'open')`,
    ),
    // A held observation is named and dated, or it is not held.
    pendingCheck: check(
      'watched_spots_pending_check',
      sql`(${table.pendingKind} IS NULL) = (${table.pendingSince} IS NULL)
          AND (${table.pendingKind} IS NULL OR ${table.pendingKind} IN ('seat_opened', 'waitlist_reopened'))`,
    ),
    // A release is complete and named, or it did not happen. Half of one is a watch
    // quietly deleted, which is the one ending a ledger must never allow.
    releaseCheck: check(
      'watched_spots_release_check',
      sql`(${table.releasedAt} IS NULL) = (${table.releasedReason} IS NULL)
          AND (${table.releasedReason} IS NULL OR ${table.releasedReason} IN ('notified', 'expired', 'parent_stopped', 'consent_withdrawn', 'unreadable_streak', 'registration_closed', 'delivery_failed', 'send_unconfirmed'))`,
    ),
    // A confirmation of an opening that never happened is unwritable.
    notifyCheck: check(
      'watched_spots_notify_check',
      sql`${table.notifiedTransitions} <= ${table.openTransitions}`,
    ),
    // One LIVE watch per family per course page, as a constraint rather than a
    // convention. It is the insert-as-claim anchor: a parent who asks twice, or a double
    // tick, conflicts here instead of minting a second watch that would text the same
    // phone twice about one seat. PARTIAL, so a released watch stays in history and the
    // same page can be watched again next season.
    liveUniq: uniqueIndex('watched_spots_live_uniq')
      .on(table.familyId, table.sourceUrl)
      .where(sql`${table.releasedAt} IS NULL`),
    // The sweep's whole working set, in the order it spends its budget.
    dueIdx: index('watched_spots_due_idx')
      .on(table.nextPollAt)
      .where(sql`${table.releasedAt} IS NULL`),
    // Every watch this family ever armed, newest first.
    familyIdx: index('watched_spots_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type WatchedSpot = typeof watchedSpots.$inferSelect;
export type NewWatchedSpot = typeof watchedSpots.$inferInsert;

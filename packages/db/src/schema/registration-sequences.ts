import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { actions } from './actions.js';
import { children } from './children.js';
import { registrationOutcomeEnum } from './enums.js';
import { families } from './families.js';
import type { RegistrationSourceState } from './registration-state.js';
import { users } from './users.js';

/** Public course URLs need not fit the PerfectMind-only SMS link bound. */
export const REGISTRATION_COURSE_URL_MAX_CHARS = 2048;

/**
 * VIL-242 · M7 — one row per (family, registration window) that Hale has taken the
 * morning over for. The row IS the claim: while it exists, M4's proactive nudge defers
 * this window to the sequence rather than announcing it a second time.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - a status column. Whether the parent approved the shortlist lives in `actions`
 *     (the approval spine), and it is read LIVE every tick through `action_id`. A
 *     mirrored status is a second place consent can be recorded, and the two would
 *     eventually disagree about whether a family said yes — which is the one thing
 *     rule #4 cannot tolerate.
 *   - per-leg rows. D1's event_reminders materializes a ledger because reminders must
 *     batch and cancel; a sequence leg does neither. Every leg's firing interval is a
 *     pure function of the window's live `open_at` (see sequence/schedule.ts), so a
 *     municipality that MOVES a date re-anchors the whole ladder by construction — no
 *     converge phase, and nothing stale to reconcile. Idempotency is the
 *     channel_messages dedupe key, exactly as it is for M4.
 *
 * What IS here is the state nothing else can derive: what the parent told us happened
 * after the window opened, the waitlist clock that answer started, and — VIL-338 — the
 * course page the parent pasted, the instant that page says it opens for THIS family,
 * and the parent's own word about their portal setup. No lookup reproduces those three:
 * a paste has no other home, the anchor is the municipality's own system of record and
 * the sweep runs 288 times a day, and readiness is something only the parent knows. None
 * of them is a status — how far along the ladder is stays a pure function of the window's
 * live clock, for the same reason the status column above is absent.
 */
export const registrationSequences = pgTable(
  'registration_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Legacy window association; a URL-owned watch does not require one. */
    /** Imported identity retained only for delivered-message dedupe, not a catalog FK. */
    windowId: uuid('window_id'),
    sourceContext: jsonb('source_context').$type<RegistrationSourceState>(),
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    /** The parent the legs are addressed to — one household, one thread (rule: ONE
     * message per family, never one per kid or per parent). */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The shortlist draft held for approval. The parent approving it is the opt-in
     * that unlocks the battle plan, the go leg and their quiet-hours exemption. Null
     * only if the draft was later erased; `set null` keeps the claim intact so the
     * family does not suddenly get M4's duplicate announcement instead. */
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),
    /** What the parent reported. Null while the window has not been answered for. */
    outcome: registrationOutcomeEnum('outcome'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    /** The position the parent quoted ("waitlisted #15"), where they quoted one. */
    waitlistPosition: integer('waitlist_position'),
    /** When the PARENT told us they were waitlisted — not when the municipality made
     * the offer, which Hale has no way to see. The guards count from here and the copy
     * says so, because a deadline is only as honest as its start. */
    waitlistStartedAt: timestamp('waitlist_started_at', { withTimezone: true }),
    /** waitlist_started_at + the municipality's published response window. Null where
     * the municipality publishes none and Hale may not invent a clock. */
    waitlistDeadlineAt: timestamp('waitlist_deadline_at', { withTimezone: true }),
    /** The one gentle re-ask has been spent; after this an unreadable reply is met
     * with silence rather than a third question. */
    reaskedAt: timestamp('reasked_at', { withTimezone: true }),
    /** A validated public registration URL. Legacy PerfectMind links keep their
     * existing sanitizer; storing a generic URL does not authorize a network fetch. */
    courseUrl: text('course_url'),
    /** Scheduling cache, not parent-facing truth. Null while the page's date is unknown. */
    courseOpensAt: timestamp('course_opens_at', { withTimezone: true }),
    /** The unified reading, with checkedAt serialized as ISO. Never a page body. */
    lastReading: jsonb('last_reading').$type<Record<string, unknown>>(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    /** Null on legacy rows until the refresh path takes ownership. */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    /** A change awaiting notification keeps its own evidence until delivery succeeds. */
    pendingChange: jsonb('pending_change').$type<Record<string, unknown>>(),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Approval for a later date is separate from the original watch opt-in. */
    dateReviewActionId: uuid('date_review_action_id').references(() => actions.id, {
      onDelete: 'set null',
    }),
    /** The parent's own answer about their portal setup — never inferred, never verified.
     * NULL is unasked-or-unanswered and false is "they said no": the copy renders both as
     * "you have not told me the setup is done", which is true of each, and only true as
     * "you told me the setup is done". Collapsing NULL into false would make silence read
     * as a refusal the parent never gave. */
    readinessReady: boolean('readiness_ready'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    courseUrlLengthCheck: check(
      'registration_sequences_course_url_length_check',
      sql`${table.courseUrl} IS NULL OR length(${table.courseUrl}) BETWEEN 1 AND ${REGISTRATION_COURSE_URL_MAX_CHARS}`,
    ),
    // A URL may precede its date; a cached course date still needs a source.
    courseCheck: check(
      'registration_sequences_course_check',
      sql`${table.courseOpensAt} IS NULL OR ${table.courseUrl} IS NOT NULL`,
    ),
    targetCheck: check(
      'registration_sequences_target_check',
      sql`${table.windowId} IS NOT NULL OR ${table.courseUrl} IS NOT NULL`,
    ),
    dateReviewCheck: check(
      'registration_sequences_date_review_check',
      sql`${table.dateReviewActionId} IS NULL OR ${table.pendingChange} IS NOT NULL`,
    ),
    // New URL-owned watches dedupe without repairing or deleting legacy window rows.
    liveUrlUniq: uniqueIndex('registration_sequences_live_url_uniq')
      .on(table.familyId, table.courseUrl)
      .where(
        sql`${table.windowId} IS NULL AND (${table.outcome} IS NULL OR ${table.outcome} = 'waitlisted')`,
      ),
    dueIdx: index('registration_sequences_check_idx')
      .on(table.nextCheckAt)
      .where(
        sql`${table.nextCheckAt} IS NOT NULL AND (${table.outcome} IS NULL OR ${table.outcome} = 'waitlisted')`,
      ),
    // The claim's natural key: one ladder per family per window, and the anchor the
    // sweep's insert conflicts on so a double cron tick cannot mint two.
    familyWindowUniq: uniqueIndex('registration_sequences_family_window_uniq').on(
      table.familyId,
      table.windowId,
    ),
    // The sweep's scan: every live sequence for a family, and the reply router's
    // lookup of the one window a family is currently being asked about.
    familyIdx: index('registration_sequences_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type RegistrationSequence = typeof registrationSequences.$inferSelect;
export type NewRegistrationSequence = typeof registrationSequences.$inferInsert;

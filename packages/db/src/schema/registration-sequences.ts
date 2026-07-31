import { index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actions } from './actions.js';
import { registrationOutcomeEnum } from './enums.js';
import { families } from './families.js';
import { registrationWindows } from './registration-windows.js';
import { users } from './users.js';

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
 * after the window opened, and the waitlist clock that answer started.
 */
export const registrationSequences = pgTable(
  'registration_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The M1 window this ladder serves. Cascades: a retired window has no sequence. */
    windowId: uuid('window_id')
      .notNull()
      .references(() => registrationWindows.id, { onDelete: 'cascade' }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
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

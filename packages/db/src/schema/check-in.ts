import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { checkInCadenceEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-353 · how often this household hears Hale's evening question, and what the
 * stop-answering ladder knows about their silence.
 *
 * ONE ROW PER FAMILY, minted on the first ask. The absence of a row is the default
 * (daily), so a family that has never been asked needs no backfill.
 *
 * THE TWO TIMESTAMPS ARE THE STATE MACHINE. `lastAnsweredAt` older than `lastAskedAt` is
 * a lapse; equal-or-newer is an answer. `silentStreak` counts consecutive lapses and is
 * advanced at the NEXT ask rather than by a timer, so one lapse is counted exactly once
 * however many times the hourly cron runs. `silentStreakSince` is the floor under that
 * counter: the evening the ladder last acted, so the lapse a step-down already answered
 * is not read off the timestamps a second time by the weekly question after it.
 */
export const familyCheckInPrefs = pgTable('family_check_in_prefs', {
  familyId: uuid('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  cadence: checkInCadenceEnum('cadence').notNull().default('daily'),
  silentStreak: integer('silent_streak').notNull().default(0),
  lastAskedAt: timestamp('last_asked_at', { withTimezone: true }),
  lastAnsweredAt: timestamp('last_answered_at', { withTimezone: true }),
  /** The instant a rung of the ladder last acted on this family's silence — asks older
   * than it have already been counted and must not be counted again. */
  silentStreakSince: timestamp('silent_streak_since', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the parent said about their day, in their own words.
 *
 * ITS OWN TABLE RATHER THAN A MEMORY FACT, and that is the privacy design rather than a
 * schema preference. `family_memory_facts` is the shared store the coach's memory tools
 * read and hand to a model; a parent's unedited sentence about their household must
 * never reach a shared, teen- or caregiver-readable surface (rule #1), and the only way
 * to make that true by construction is for the raw words to live where no existing
 * reader looks. The fact store also cannot express either property this data needs: it
 * has no expiry, and its one-live-row-per-key index would have each evening silently
 * supersede the last.
 *
 * NOTHING READS THIS TODAY. The nightly synthesis that promotes a durable fact out of a
 * week of notes is VIL-354; until it exists these rows are written, shown back to the
 * parent in their own thread, and expired.
 */
export const familyCheckInNotes = pgTable(
  'family_check_in_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The inbound row that carried the words — erasing it erases the note. */
    sourceMessageId: uuid('source_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    /** The family-local day the note is ABOUT, never the instant it arrived. */
    notedOn: date('noted_on').notNull(),
    note: text('note').notNull(),
    /** The 30-day raw TTL, stored so shortening the constant cannot extend a live row. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dayUniq: uniqueIndex('family_check_in_notes_day_uniq').on(table.familyId, table.notedOn),
    expiryIdx: index('family_check_in_notes_expiry_idx').on(table.expiresAt),
  }),
);

export type FamilyCheckInPrefs = typeof familyCheckInPrefs.$inferSelect;
export type NewFamilyCheckInPrefs = typeof familyCheckInPrefs.$inferInsert;
export type FamilyCheckInNote = typeof familyCheckInNotes.$inferSelect;
export type NewFamilyCheckInNote = typeof familyCheckInNotes.$inferInsert;

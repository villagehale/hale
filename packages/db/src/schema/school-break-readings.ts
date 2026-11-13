import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * VIL-685 · what Hale last read about one school board's winter break for one school
 * year, off that board's own calendar page.
 *
 * Keyed by the board's OFFICIAL HOST: the email domain the family's school mail comes
 * from, which the page had to be served from. Kept per board so every family whose
 * school writes from that domain costs one lookup, and never shared between boards:
 * two boards in one town are two rows, read separately.
 *
 * Family-AGNOSTIC, like city_registration_readings: a public host, a school year and
 * what a public page said. No family_id, no PII (rule #1).
 *
 * Append-only. The newest row by `read_at` for a (board_host, school_year) is the
 * reading; an older row is history.
 */
export const SCHOOL_BREAK_READING_STATUSES = ['verified', 'not_found'] as const;
export type SchoolBreakReadingStatus = (typeof SCHOOL_BREAK_READING_STATUSES)[number];

export const schoolBreakReadings = pgTable(
  'school_break_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The board's official host, lowercased: the cache key. */
    boardHost: text('board_host').notNull(),
    /** `2026-27`. */
    schoolYear: text('school_year').notNull(),
    status: text('status').$type<SchoolBreakReadingStatus>().notNull(),
    /** Why there is no date, by name: no page found, the page names no winter break, unreadable. */
    reason: text('reason'),
    /** The board or school the page belongs to, as the search named it. */
    boardName: text('board_name'),
    /** The calendar page the dates were read off. Null only when nothing verified. */
    sourceUrl: text('source_url'),
    /** The verified break: its name as printed, first and last day, and the page words
     * each day stands on. */
    reading: jsonb('reading').$type<Record<string, unknown>>(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
    /** When this reading is stale and the board is read again. */
    reverifyAt: timestamp('reverify_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    boardYearReadIdx: index('school_break_readings_board_year_read_idx').on(
      table.boardHost,
      table.schoolYear,
      table.readAt,
    ),
  }),
);

export type SchoolBreakReading = typeof schoolBreakReadings.$inferSelect;
export type NewSchoolBreakReading = typeof schoolBreakReadings.$inferInsert;

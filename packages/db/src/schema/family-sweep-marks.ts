import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * When a bounded family sweep (nightly memory inference, the memory digest) last took
 * each family. A run takes the families it has never taken or took longest ago, then
 * stamps them, so every family is reached within ceil(families / cap) runs. Ordering by
 * creation alone took the same oldest slice every night and starved the rest (VIL-597).
 *
 * Scheduling metadata only: no family content, so it is not part of the access copy.
 */
export const familySweepMarks = pgTable(
  'family_sweep_marks',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    sweep: text('sweep').notNull(),
    sweptAt: timestamp('swept_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.sweep] }),
    sweepIdx: index('family_sweep_marks_sweep_idx').on(table.sweep, table.sweptAt),
  }),
);

export type FamilySweepMark = typeof familySweepMarks.$inferSelect;

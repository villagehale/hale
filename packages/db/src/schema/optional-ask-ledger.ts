import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-392 — one ledger for optional asks.
 *
 * Cold-start logistics, names, calendar, and email asks share it with the
 * `duty_ask` send class. A count is not a hold: there is no first-week cap
 * and no one-ask-a-day cap. A decline is final, two bad asks in a row pause
 * until the parent writes again, and silence past 24h is unanswered.
 */
export const optionalAskLedger = pgTable(
  'optional_ask_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** duty_ask | logistics | names | signup | calendar | email */
    sendClass: text('send_class').notNull(),
    askKey: text('ask_key').notNull(),
    /** sent | declined. Silence past 24h is read as unanswered, not stored. */
    outcome: text('outcome').notNull(),
    /** Family-local calendar day, YYYY-MM-DD. */
    localDay: text('local_day').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('optional_ask_ledger_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type OptionalAskLedgerRow = typeof optionalAskLedger.$inferSelect;
export type NewOptionalAskLedgerRow = typeof optionalAskLedger.$inferInsert;

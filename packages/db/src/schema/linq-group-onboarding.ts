import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Where a co-parent seated from a claimed Linq group is on their own ladder.
 *
 * Name, then the calendar ask, then the Gmail ask. Each ask is its own
 * turn. The family's children and postal code are not collected again. One
 * row per user. `step` is text, not an enum: awaiting_name,
 * awaiting_calendar, awaiting_gmail, done.
 */
export const linqGroupOnboarding = pgTable(
  'linq_group_onboarding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerChatId: text('provider_chat_id').notNull(),
    step: text('step').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUniq: uniqueIndex('linq_group_onboarding_user_uniq').on(table.userId),
  }),
);

export type LinqGroupOnboarding = typeof linqGroupOnboarding.$inferSelect;
export type NewLinqGroupOnboarding = typeof linqGroupOnboarding.$inferInsert;

import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * One year-retention ask per family (ENG-1).
 *
 * The row is the open question: status `asked` until the parent says yes
 * (link sent) or no (declined). A second ask is a unique-index conflict, not
 * a second bubble. The chat id is where the ask landed — the co-parent group
 * when one exists, otherwise the 1:1 the parent already opened.
 */
export const familyUpgradeOffers = pgTable(
  'family_upgrade_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    /** `group` or `direct`. */
    channel: text('channel').notNull(),
    /** `asked`, `declined`, or `link_sent`. */
    status: text('status').notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    linkSentAt: timestamp('link_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyUniq: uniqueIndex('family_upgrade_offers_family_uniq').on(table.familyId),
  }),
);

export type FamilyUpgradeOffer = typeof familyUpgradeOffers.$inferSelect;
export type NewFamilyUpgradeOffer = typeof familyUpgradeOffers.$inferInsert;

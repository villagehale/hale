import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { familyEvents } from './family-events.js';
import { users } from './users.js';

/** Where a reading came from: the parent's own Gmail, or a flyer they sent Hale 1:1. */
export type BringItemsSourceKind = 'email' | 'photo';

/**
 * VIL-720 · what an email or flyer says to bring, against the event it is for
 * (migration 0265).
 *
 * ONE PARENT'S, ALWAYS. `ownerUserId` is the parent whose mailbox or 1:1 thread carried the
 * source, and the one reader (the 1:1 reminder) shows a row to that parent and nobody else:
 * not the co-parent who gets the same event's reminder, not a caregiver, never a group.
 *
 * `eventId` is null while the occasion is not on the calendar yet (the parent was asked
 * whether to add it); their yes sets it and `attachedAt`, their no deletes the row.
 * `sourceRef` is `<integration id>:<message id>`, the same pair as that offer row.
 *
 * Only the extracted items, never the email, the flyer or a quote of either (rule #1).
 */
export const familyEventBringItems = pgTable(
  'family_event_bring_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => familyEvents.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').$type<BringItemsSourceKind>().notNull(),
    sourceRef: text('source_ref').notNull(),
    items: jsonb('items').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
  },
  (table) => ({
    ownerSourceUniq: uniqueIndex('family_event_bring_items_owner_source_uniq').on(
      table.ownerUserId,
      table.sourceRef,
    ),
    eventOwnerIdx: index('family_event_bring_items_event_owner_idx')
      .on(table.eventId, table.ownerUserId)
      .where(sql`${table.eventId} IS NOT NULL`),
    pendingIdx: index('family_event_bring_items_pending_idx')
      .on(table.ownerUserId, table.createdAt)
      .where(sql`${table.eventId} IS NULL`),
    sourceKindCheck: check(
      'family_event_bring_items_source_kind_check',
      sql`${table.sourceKind} IN ('email', 'photo')`,
    ),
    itemsArrayCheck: check(
      'family_event_bring_items_items_array_check',
      sql`jsonb_typeof(${table.items}) = 'array'`,
    ),
    attachedCheck: check(
      'family_event_bring_items_attached_check',
      sql`(${table.eventId} IS NULL) OR (${table.attachedAt} IS NOT NULL)`,
    ),
  }),
);

export type FamilyEventBringItems = typeof familyEventBringItems.$inferSelect;

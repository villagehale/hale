import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-447 (T23) — shared lists in a family group (groceries, packing, anything).
 *
 * A list belongs to ONE group thread (`conversation_id`), never to a family at large, so
 * a list made in one group is never read in another group or in a 1:1. Items hold only
 * what someone said in that group. Who added or checked an item is a user id; the name
 * shown is read from `users` at read time, so nothing here copies a person's name.
 * No size cap (ticket scope). `archived_at` retires a list without deleting history.
 */
export const groupLists = pgTable(
  'group_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    liveNameUniq: uniqueIndex('group_lists_live_name_uniq')
      .on(table.conversationId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
    conversationIdx: index('group_lists_conversation_idx').on(table.conversationId),
    nameLength: check(
      'group_lists_name_length_check',
      sql`char_length(${table.name}) BETWEEN 1 AND 200`,
    ),
  }),
);

export const groupListItems = pgTable(
  'group_list_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => groupLists.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** `text` case-, width- and space-folded (foldListText); one OPEN row per key. */
    textKey: text('text_key').notNull(),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    checkedByUserId: uuid('checked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    openKeyUniq: uniqueIndex('group_list_items_open_key_uniq')
      .on(table.listId, table.textKey)
      .where(sql`${table.checkedAt} IS NULL`),
    listOpenIdx: index('group_list_items_list_idx').on(table.listId, table.checkedAt),
    textLength: check(
      'group_list_items_text_length_check',
      sql`char_length(${table.text}) BETWEEN 1 AND 500`,
    ),
  }),
);

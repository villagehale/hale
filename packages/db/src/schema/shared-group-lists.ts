import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { linqSharedGroupPeople } from './linq-multi-family.js';

/**
 * VIL-687 — what a multi-family group chat is bringing or giving, and who has each thing.
 *
 * A row belongs to ONE shared Linq chat (`chat_id`), never to a family: several families
 * share it. People are `linq_shared_group_people` rows, so a guest who is not a Hale
 * customer can own an item too, and names are read from that row at read time.
 *
 * `owner_person_id` null means the item is still open. An item someone added belongs to
 * them: when their presence row is forgotten (they left, Hale left, or their family was
 * erased) the item goes with it. An owner who is forgotten only frees the item.
 *
 * Hidden gifts: `hidden_for_kid` (the child the gift is for, as said in the chat),
 * `hidden_from_person_ids` (the people the model named as that child's family) and
 * `hidden_from_family_ids` (their Hale families) mark an item that is never rendered to
 * that child's family. Code applies it on every read.
 */
export const sharedGroupListItems = pgTable(
  'shared_group_list_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    listName: text('list_name').notNull(),
    /** `list_name` folded by foldListText. */
    listKey: text('list_key').notNull(),
    text: text('text').notNull(),
    /** `text` folded by foldListText; one row per thing per list. */
    textKey: text('text_key').notNull(),
    addedByPersonId: uuid('added_by_person_id')
      .notNull()
      .references(() => linqSharedGroupPeople.id, { onDelete: 'cascade' }),
    ownerPersonId: uuid('owner_person_id').references(() => linqSharedGroupPeople.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    hiddenForKid: text('hidden_for_kid'),
    hiddenFromPersonIds: uuid('hidden_from_person_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** The families of `hidden_from_person_ids` when it was written, so a co-parent counts too. */
    hiddenFromFamilyIds: uuid('hidden_from_family_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemUniq: uniqueIndex('shared_group_list_items_item_uniq').on(
      table.chatId,
      table.listKey,
      table.textKey,
    ),
    chatIdx: index('shared_group_list_items_chat_idx').on(table.chatId, table.addedAt),
    listNameLength: check(
      'shared_group_list_items_list_name_length_check',
      sql`char_length(${table.listName}) BETWEEN 1 AND 200`,
    ),
    listKeyLength: check(
      'shared_group_list_items_list_key_length_check',
      sql`char_length(${table.listKey}) >= 1`,
    ),
    textLength: check(
      'shared_group_list_items_text_length_check',
      sql`char_length(${table.text}) BETWEEN 1 AND 500`,
    ),
    textKeyLength: check(
      'shared_group_list_items_text_key_length_check',
      sql`char_length(${table.textKey}) >= 1`,
    ),
    hiddenForKidLength: check(
      'shared_group_list_items_hidden_for_kid_length_check',
      sql`${table.hiddenForKid} IS NULL OR char_length(${table.hiddenForKid}) BETWEEN 1 AND 100`,
    ),
  }),
);

export type SharedGroupListItem = typeof sharedGroupListItems.$inferSelect;

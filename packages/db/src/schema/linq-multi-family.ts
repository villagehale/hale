import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consentRecords } from './consent.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-399 — one live row per family that has explicitly joined a shared Linq
 * group. A second family in the chat is not a join. `consent_record_id` is
 * that family's own consent; Hale does not use the family's data in the group
 * without it. `left_at` is the family leaving. Closed rows stay.
 */
export const linqMultiFamilyJoins = pgTable(
  'linq_multi_family_joins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    joinedByUserId: uuid('joined_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    consentRecordId: uuid('consent_record_id').references(() => consentRecords.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    liveUniq: uniqueIndex('linq_multi_family_joins_live_uniq')
      .on(table.chatId, table.familyId)
      .where(sql`${table.leftAt} IS NULL`),
    familyIdx: index('linq_multi_family_joins_family_idx').on(table.familyId),
  }),
);

/**
 * Seats in a shared group. Separate from `linq_group_members`, whose one
 * live seat per phone still belongs to the household group. A phone may hold
 * a household seat and a shared seat. One live seat per phone per chat.
 */
export const linqMultiFamilyMembers = pgTable(
  'linq_multi_family_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    phoneE164Hash: text('phone_e164_hash').notNull(),
    role: text('role').notNull(),
    seatedAt: timestamp('seated_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      'linq_multi_family_members_role_check',
      sql`${table.role} in ('parent', 'co_parent', 'other_family', 'caregiver')`,
    ),
    liveChatPhone: uniqueIndex('linq_multi_family_members_live_chat_phone_uniq')
      .on(table.chatId, table.phoneE164Hash)
      .where(sql`${table.removedAt} IS NULL`),
    familyIdx: index('linq_multi_family_members_family_idx').on(table.familyId),
  }),
);

/** Per-family ask and send counts inside one shared chat. */
export const linqMultiFamilyLedger = pgTable(
  'linq_multi_family_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCheck: check('linq_multi_family_ledger_kind_check', sql`${table.kind} in ('ask', 'send')`),
    chatIdx: index('linq_multi_family_ledger_chat_idx').on(table.chatId, table.createdAt),
    familyIdx: index('linq_multi_family_ledger_family_idx').on(
      table.familyId,
      table.chatId,
      table.createdAt,
    ),
  }),
);

export type LinqMultiFamilyJoin = typeof linqMultiFamilyJoins.$inferSelect;
export type LinqMultiFamilyMember = typeof linqMultiFamilyMembers.$inferSelect;
export type LinqMultiFamilyLedgerRow = typeof linqMultiFamilyLedger.$inferSelect;

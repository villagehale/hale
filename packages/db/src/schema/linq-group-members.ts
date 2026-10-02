import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-398 — one row per person in a household's Linq group.
 *
 * Roles are the group seat, not `family_members.role`: parent, co_parent,
 * other_family, caregiver. There is no cap on how many rows a chat may hold.
 * A phone has at most one live seat (`removed_at` is null), so a number that
 * already belongs to another family cannot be seated again.
 *
 * The number is encrypted. `phone_e164_hash` is the blind index the webhook
 * resolves. Unseat sets `removed_at` and keeps the row.
 */
export const LINQ_GROUP_MEMBER_ROLES = [
  'parent',
  'co_parent',
  'other_family',
  'caregiver',
] as const;
export type LinqGroupMemberRole = (typeof LINQ_GROUP_MEMBER_ROLES)[number];

export const linqGroupMembers = pgTable(
  'linq_group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    phoneE164Hash: text('phone_e164_hash').notNull(),
    role: text('role').notNull().$type<LinqGroupMemberRole>(),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    seatedAt: timestamp('seated_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    welcomedAt: timestamp('welcomed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      'linq_group_members_role_check',
      sql`${table.role} in ('parent', 'co_parent', 'other_family', 'caregiver')`,
    ),
    liveChatPhone: uniqueIndex('linq_group_members_live_chat_phone_uniq')
      .on(table.chatId, table.phoneE164Hash)
      .where(sql`${table.removedAt} IS NULL`),
    livePhone: uniqueIndex('linq_group_members_live_phone_uniq')
      .on(table.phoneE164Hash)
      .where(sql`${table.removedAt} IS NULL`),
    familyIdx: index('linq_group_members_family_idx').on(table.familyId),
  }),
);

export type LinqGroupMember = typeof linqGroupMembers.$inferSelect;
export type NewLinqGroupMember = typeof linqGroupMembers.$inferInsert;

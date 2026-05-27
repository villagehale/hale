import { pgTable, uuid, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';
import { familyRoleEnum } from './enums.js';

export const familyMembers = pgTable(
  'family_members',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: familyRoleEnum('role').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.userId] }),
    userIdx: index('family_members_user_idx').on(table.userId),
  }),
);

export type FamilyMember = typeof familyMembers.$inferSelect;
export type NewFamilyMember = typeof familyMembers.$inferInsert;

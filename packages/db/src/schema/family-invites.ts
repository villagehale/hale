import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';
import { familyRoleEnum } from './enums.js';

/**
 * A pending co-parent invite. An existing family member mints a token (rule #5:
 * only members invite); the invitee redeems it to join as a `co_parent`. The
 * token is the only credential — cryptographically random, UNIQUE, single-use
 * (accepted_at stamps redemption). expires_at bounds the window.
 */
export const familyInvites = pgTable(
  'family_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    email: text('email'),
    role: familyRoleEnum('role').notNull().default('co_parent'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('family_invites_family_idx').on(table.familyId),
  }),
);

export type FamilyInvite = typeof familyInvites.$inferSelect;
export type NewFamilyInvite = typeof familyInvites.$inferInsert;

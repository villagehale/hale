import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name'),
    locale: text('locale').notNull().default('en-CA'),
    timezone: text('timezone').notNull().default('America/Toronto'),
    /** External auth provider id (Clerk user id). Auth lives in Clerk; this is the mirror. */
    externalAuthId: text('external_auth_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
    externalAuthIdx: index('users_external_auth_idx').on(table.externalAuthId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

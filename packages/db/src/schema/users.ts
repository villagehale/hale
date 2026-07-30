import { pgTable, uuid, text, smallint, timestamp, index } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULLABLE since VIL-237: an SMS-provisioned parent (the phone number IS the
     * account) has no address at all. Still UNIQUE — Postgres permits many NULLs in
     * a unique index, so "one account per address" holds for everyone who has one.
     * Every email-sending path must therefore treat a null address as "skip", not
     * as an error (rule #8 boundary, not a masked null). */
    email: text('email').unique(),
    name: text('name'),
    locale: text('locale').notNull().default('en-CA'),
    timezone: text('timezone').notNull().default('America/Toronto'),
    units: text('units').notNull().default('metric'),
    weekStartDay: smallint('week_start_day').notNull().default(1),
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

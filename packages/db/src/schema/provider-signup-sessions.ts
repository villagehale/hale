import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * T8 — a parent's logged-in provider session, captured the day before a
 * registration so the Browser Use engine can open the provider site signed in.
 *
 * One row per family and provider host. `storage_state_ciphertext` is an
 * AES-256-GCM blob (APP_ENCRYPTION_KEY) of cookies and local storage only. It
 * is never a password. The row is deleted when the parent confirms they are in,
 * or by the hourly delete sweep once `expires_at` (captured + 48h) passes. The
 * Browser Use profile seeded from it is deleted with it.
 */
export const providerSignupSessions = pgTable(
  'provider_signup_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Provider host the cookies belong to, normalized by `signupProviderHost`. */
    providerHost: text('provider_host').notNull(),
    storageStateCiphertext: text('storage_state_ciphertext').notNull(),
    /** Browser Use profile seeded from this state. Deleted with the row. */
    browserUseProfileId: text('browser_use_profile_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyHostIdx: uniqueIndex('provider_signup_sessions_family_host_idx').on(
      table.familyId,
      table.providerHost,
    ),
    expiresIdx: index('provider_signup_sessions_expires_idx').on(table.expiresAt),
  }),
);

export type ProviderSignupSession = typeof providerSignupSessions.$inferSelect;

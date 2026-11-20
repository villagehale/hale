import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-558 · a parent's city-site username, password and optional TOTP seed,
 * per family and provider host (Barton, 11/10/2026: replace the 10/21
 * session-only rule with encrypted credentials).
 *
 * Ciphertexts are AES-256-GCM under the family's DEK (see
 * `family_provider_data_keys`). They are decrypted only inside a Browser Use
 * login run and passed as secret aliases; they never enter a prompt, log,
 * audit row, PostHog, Sentry, error or test snapshot. The cookie/local-storage
 * vault (`provider_signup_sessions`) still refuses password-named keys.
 *
 * Deleted when the parent asks, when the last plan on this host finishes plus
 * 45 days, on family erasure (cascade), or by the hourly sweep.
 */
export const providerSignupCredentials = pgTable(
  'provider_signup_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerHost: text('provider_host').notNull(),
    usernameCiphertext: text('username_ciphertext').notNull(),
    passwordCiphertext: text('password_ciphertext').notNull(),
    totpSeedCiphertext: text('totp_seed_ciphertext'),
    dekVersion: integer('dek_version').notNull(),
    masterKeyVersion: integer('master_key_version').notNull(),
    /**
     * Set when a stored login is rejected (password or 2FA). A stale row is
     * never decrypted for a run. A successful save through a refresh link
     * clears it.
     */
    staleAt: timestamp('stale_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyHostIdx: uniqueIndex('provider_signup_credentials_family_host_idx').on(
      table.familyId,
      table.providerHost,
    ),
    familyIdx: index('provider_signup_credentials_family_idx').on(table.familyId),
  }),
);

export type ProviderSignupCredential = typeof providerSignupCredentials.$inferSelect;

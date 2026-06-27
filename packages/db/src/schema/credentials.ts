import { isNotNull } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Email + password identities, alongside Google OAuth. A row is the *credential*,
 * not the app user: the mirrored `users` row keys off `external_auth_id`, which for
 * a credentials login is `credentials:<this id>` (see lib/auth/credentials.ts). So
 * the downstream family-linking flow is identical to a Google user's — the only
 * Hale-specific identity is still `users.external_auth_id`.
 *
 * `email` is stored lowercased and UNIQUE so a duplicate sign-up is caught at the
 * DB (the unique index is the source of truth, not an app-level pre-check — race
 * safe). `password_hash` is an argon2id hash, never the plaintext (rule #1).
 * `email_verified_at` is null until the user clicks the verification link; the
 * single-use `verification_token` is the only credential in that link, and
 * `verification_sent_at` bounds its validity window.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    verificationToken: text('verification_token'),
    verificationSentAt: timestamp('verification_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial unique index: every active (unredeemed) token is unique and the
    // redeem lookup is indexed, while the many NULLs (verified / expired rows,
    // where the token is cleared) are allowed.
    verificationTokenIdx: uniqueIndex('credentials_verification_token_unique')
      .on(table.verificationToken)
      .where(isNotNull(table.verificationToken)),
  }),
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

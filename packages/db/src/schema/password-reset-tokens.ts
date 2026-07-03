import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { credentials } from './credentials.js';

/**
 * Single-use, expiring password-reset tokens. Unlike the email-verification token
 * (which is a low-value confirmation stored on the credentials row), a reset token
 * grants a password change — account takeover if leaked — so ONLY its SHA-256 hash
 * is stored (`token_hash`), never the token itself (rule #1). A DB read can never
 * reconstruct a usable link; the raw token exists only in the email and the URL.
 *
 * One row per issued token. `used_at` burns the token on redemption (single use);
 * `expires_at` bounds the window. A new request invalidates the credential's prior
 * unused tokens (see lib/auth/credentials.ts) so only the latest link works.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    credentialIdx: index('password_reset_tokens_credential_idx').on(table.credentialId),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

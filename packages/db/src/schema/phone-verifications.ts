import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Ephemeral OTP state for phone enrolment (VIL-212). One row per issued code. Like
 * a magic link, the 6-digit code grants a state change (verifies a channel) — so
 * ONLY its SHA-256 hash is stored (`code_hash`), never the code itself (rule #1).
 * The number being verified is PII, so it is stored ENCRYPTED at rest
 * (`phone_e164_encrypted`, same AES-256-GCM envelope as parent_channels).
 *
 * Lifecycle:
 *   - `consumed_at` burns the code on a successful verify (single use).
 *   - `expires_at` bounds the 10-minute window.
 *   - `attempt_count` counts WRONG guesses; at the lockout ceiling the code is dead
 *     (a fresh send is required), which — inside the 10-minute expiry — is the
 *     "3 wrong tries locks for 10 min" behaviour.
 *   - `last_sent_at` gates the 60-second resend cooldown.
 *
 * A new send invalidates the user's prior unconsumed verifications so only the
 * newest code works, mirroring magic_link_tokens.
 */
export const phoneVerifications = pgTable(
  'phone_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base64(iv ‖ authTag ‖ ciphertext) of the E.164 number being verified. */
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('phone_verifications_user_idx').on(table.userId),
  }),
);

export type PhoneVerification = typeof phoneVerifications.$inferSelect;
export type NewPhoneVerification = typeof phoneVerifications.$inferInsert;

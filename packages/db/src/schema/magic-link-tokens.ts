import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Single-use, expiring magic-link (passwordless) sign-in tokens. Like the
 * password-reset token, a magic link grants a signed-in session — account
 * takeover if leaked — so ONLY its SHA-256 hash is stored (`token_hash`), never
 * the token itself (rule #1). A DB read can never reconstruct a usable link; the
 * raw token exists only in the email and the URL.
 *
 * Unlike password-reset tokens, this table keys off `email` (a plain column, no FK
 * to credentials): a magic link doubles as first-time SIGN-UP, so it must be
 * mintable for an address that has no `credentials` row yet. Redemption find-or-
 * creates the credential (see apps/web/lib/auth/magic-link.ts).
 *
 * One row per issued token. `consumed_at` burns the token on redemption (single
 * use, via an atomic conditional UPDATE); `expires_at` bounds the ~15-minute
 * window. A new request invalidates the email's prior unconsumed tokens so only
 * the latest link works.
 */
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index('magic_link_tokens_email_idx').on(table.email),
  }),
);

export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert;

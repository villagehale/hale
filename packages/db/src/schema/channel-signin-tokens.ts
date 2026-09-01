import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Single-use, expiring sign-in tokens for accounts that arrived by PHONE — the
 * magic-link lifecycle keyed on `user_id` instead of `email`.
 *
 * WHY NOT magic_link_tokens. That table keys off an email address because a magic
 * link doubles as sign-up, and redemption find-or-creates a credential. An
 * SMS-onboarded parent has `email` NULL and `external_auth_id = 'sms:<blind index>'`
 * (channel/intake/provision.ts), so an email token cannot reach them — and redeeming
 * one would find-or-create a SECOND, empty account beside the family the number
 * already owns. This table's whole design is that redemption resolves the identity
 * the account ALREADY has and can create nothing.
 *
 * WHY ONLY THE HASH (rule #1). The token grants a signed-in session — account
 * takeover if leaked — so only its SHA-256 digest is stored, exactly as the
 * magic-link and join-invite rows do: a DB read can never reconstruct a usable link.
 * The raw token exists only in the SMS that carried it.
 *
 * SINGLE USE, FIFTEEN MINUTES. `consumed_at` burns it via an atomic conditional
 * UPDATE; `expires_at` bounds the window; a fresh mint invalidates the user's prior
 * unconsumed tokens (the magic-link convention, not the join link's — a stale
 * sign-in link is pure risk and nobody has forwarded it anywhere).
 */
export const channelSigninTokens = pgTable(
  'channel_signin_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the raw token. Never the token itself. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on redemption — the burn that makes the link single-use. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('channel_signin_tokens_user_idx').on(table.userId),
  }),
);

export type ChannelSigninToken = typeof channelSigninTokens.$inferSelect;
export type NewChannelSigninToken = typeof channelSigninTokens.$inferInsert;

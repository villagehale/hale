import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * T8 — a parent's own Stripe Link Agent Wallet authorization.
 *
 * One row per family and parent: each parent pays with their own Link account
 * and approves each spend request with their own Face ID or passkey in Link.
 * `refresh_token_ciphertext` is an AES-256-GCM blob (APP_ENCRYPTION_KEY) of the
 * Link OAuth refresh token. Link rotates it on every refresh, so the row is
 * rewritten each time. No card number is ever stored.
 */
export const familyLinkWallets = pgTable(
  'family_link_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenCiphertext: text('refresh_token_ciphertext').notNull(),
    /** Scopes the parent actually granted, as Link echoed them. */
    scope: text('scope').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyParentIdx: uniqueIndex('family_link_wallets_family_parent_idx').on(
      table.familyId,
      table.parentUserId,
    ),
  }),
);

export type FamilyLinkWallet = typeof familyLinkWallets.$inferSelect;

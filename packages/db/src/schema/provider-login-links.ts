import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authorizedSignupOffers } from './authorized-signup-offers.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-558 · a single-use, short-lived token for the parent-facing city login
 * page. The raw token exists only in the SMS; the row keeps its digest.
 * Tied to one family, one provider host and one plan. Opening the page does
 * not consume it; a successful capture or credential save does.
 *
 * `browser_handle_ciphertext` is an ephemeral CDP handle for the live view,
 * encrypted, never audited, dropped when the token is consumed.
 */
export const providerLoginLinks = pgTable(
  'provider_login_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id').references(() => authorizedSignupOffers.id, { onDelete: 'cascade' }),
    providerHost: text('provider_host').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Browser Use browser id while the parent is on the live view. Not a credential. */
    browserId: text('browser_id'),
    /** Encrypted { cdpUrl }. Credential-grade; deleted with the consume. */
    browserHandleCiphertext: text('browser_handle_ciphertext'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Page purpose facts (host, session label, open time). Never a password. */
    purpose: jsonb('purpose').$type<Record<string, unknown>>(),
  },
  (table) => ({
    tokenHashUniq: uniqueIndex('provider_login_links_token_hash_idx').on(table.tokenHash),
    familyIdx: index('provider_login_links_family_idx').on(table.familyId, table.createdAt),
    expiresIdx: index('provider_login_links_expires_idx').on(table.expiresAt),
  }),
);

export type ProviderLoginLink = typeof providerLoginLinks.$inferSelect;

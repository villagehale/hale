import { pgTable, uuid, timestamp, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * Single-use nonces for the MOBILE connector OAuth flow. The web flow closes
 * consent-fixation with a session check at the callback (session user must equal
 * the state's bound user), but the mobile callback has no browser session to check
 * — the app rides a Bearer token that Google's redirect can't carry. So a mobile
 * connect mints a nonce here, embeds it in the signed state, and the callback
 * CONSUMES it (deletes the row): a state can only complete a connection once, so a
 * captured/replayed mobile consent url can't be reused (rule #1).
 *
 * One row per issued mobile state. `expires_at` bounds the window (matches the
 * state TTL); a sweep of expired rows is a follow-up — an expired nonce is simply
 * never consumable (the state has also expired by then).
 */
export const connectorConnectNonces = pgTable(
  'connector_connect_nonces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('connector_connect_nonces_family_idx').on(table.familyId),
  }),
);

export type ConnectorConnectNonce = typeof connectorConnectNonces.$inferSelect;
export type NewConnectorConnectNonce = typeof connectorConnectNonces.$inferInsert;

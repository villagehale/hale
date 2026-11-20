import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authorizedSignupOffers } from './authorized-signup-offers.js';
import { families } from './families.js';

/**
 * VIL-558 · one outbound login-prep / session-dead / pre-open / warning /
 * login-done / register-now text per plan and kind, so two providers never
 * share a reminder and a second send of the same kind is a no-op.
 *
 * The body is never stored here. Audit rows name the kind and host only.
 */
export const providerLoginNotices = pgTable(
  'provider_login_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => authorizedSignupOffers.id, { onDelete: 'cascade' }),
    providerHost: text('provider_host').notNull(),
    kind: text('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    oneKind: uniqueIndex('provider_login_notices_offer_kind_idx').on(table.offerId, table.kind),
  }),
);

export type ProviderLoginNotice = typeof providerLoginNotices.$inferSelect;

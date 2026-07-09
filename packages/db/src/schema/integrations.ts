import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { isNotNull } from 'drizzle-orm';
import { families } from './families.js';
import { users } from './users.js';
import { integrationProviderEnum, integrationStatusEnum } from './enums.js';

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Some integrations are user-scoped (one parent's Gmail); some are family-wide (Stripe). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    provider: integrationProviderEnum('provider').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    /** Envelope-encrypted OAuth tokens (app-level encryption via APP_ENCRYPTION_KEY). */
    oauthTokensEncrypted: text('oauth_tokens_encrypted'),
    /** Provider-specific metadata: webhook subscription ids, push channel ids, etc. */
    providerMetadata: jsonb('provider_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: integrationStatusEnum('status').notNull().default('connecting'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyProviderIdx: index('integrations_family_provider_idx').on(table.familyId, table.provider),
    // One connection per (family, user, provider) for user-scoped integrations
    // (the connector case), so two concurrent connect callbacks can't insert
    // duplicate rows (double polling / double events). Partial (user_id NOT NULL)
    // to leave family-wide integrations (null user_id, e.g. Stripe) unconstrained.
    familyUserProviderUnique: uniqueIndex('integrations_family_user_provider_unique')
      .on(table.familyId, table.userId, table.provider)
      .where(isNotNull(table.userId)),
  }),
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { consentRecords } from './consent.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Public OAuth clients dynamically registered by MCP hosts. These rows carry no
 * family data and no secret: Hale supports public clients with PKCE S256 only.
 */
export const mcpOauthClients = pgTable('mcp_oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Short-lived, single-use authorization codes. Only a keyed blind index of the
 * bearer code is stored; PKCE binds exchange to the initiating public client.
 */
export const mcpAuthorizationCodes = pgTable(
  'mcp_authorization_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    consentRecordId: uuid('consent_record_id')
      .notNull()
      .references(() => consentRecords.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    resource: text('resource').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    codeChallenge: text('code_challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashIdx: uniqueIndex('mcp_authorization_codes_code_hash_idx').on(table.codeHash),
    expiryIdx: index('mcp_authorization_codes_expiry_idx').on(table.expiresAt),
  }),
);

/**
 * Revocable MCP access grants. The plaintext access token is returned exactly
 * once and never stored; `token_hash` is a keyed blind index used for lookup.
 */
export const mcpGrants = pgTable(
  'mcp_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.clientId, { onDelete: 'cascade' }),
    consentRecordId: uuid('consent_record_id')
      .notNull()
      .references(() => consentRecords.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    resource: text('resource').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex('mcp_grants_token_hash_idx').on(table.tokenHash),
    userActiveIdx: index('mcp_grants_user_active_idx').on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    familyIdx: index('mcp_grants_family_idx').on(table.familyId),
  }),
);

export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type NewMcpOauthClient = typeof mcpOauthClients.$inferInsert;
export type McpAuthorizationCode = typeof mcpAuthorizationCodes.$inferSelect;
export type NewMcpAuthorizationCode = typeof mcpAuthorizationCodes.$inferInsert;
export type McpGrant = typeof mcpGrants.$inferSelect;
export type NewMcpGrant = typeof mcpGrants.$inferInsert;

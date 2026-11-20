import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-558 · per-family data-encryption keys for city-site credentials
 * (Barton, 11/10/2026: Hale may encrypt and store the city username, password
 * and optional TOTP seed).
 *
 * The DEK is a random 32-byte AES-256 key. It is wrapped (AES-256-GCM) by a
 * master key held outside the DB (`PROVIDER_CREDENTIALS_MASTER_KEY`) through
 * the KMS interface in apps/web/lib/signup/credentials/kms.ts. A real KMS can
 * replace the env wrapper without changing this table: `master_key_version`
 * names which wrapping key sealed the blob.
 *
 * One live version per family. Rotation writes a new version and rewraps
 * credentials; old versions stay until every row that names them is rewritten.
 * Family erasure cascades the row.
 */
export const familyProviderDataKeys = pgTable(
  'family_provider_data_keys',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    keyVersion: integer('key_version').notNull(),
    /** AES-256-GCM blob of the 32-byte DEK, wrapped by the master key. Never a password. */
    wrappedDek: text('wrapped_dek').notNull(),
    masterKeyVersion: integer('master_key_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.keyVersion] }),
  }),
);

export type FamilyProviderDataKey = typeof familyProviderDataKeys.$inferSelect;

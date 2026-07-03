import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';
import { consentTypeEnum } from './enums.js';

export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: consentTypeEnum('consent_type').notNull(),
    /** Free-form key when consent is for a specific integration or action class. */
    consentScope: text('consent_scope'),
    granted: boolean('granted').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** When a time-limited consent lapses. NULL for open-ended consents (ToS,
     * privacy). Set for a teen_content_access grant — the read side honours a grant
     * only while now < expires_at (rule #1 named exception: time-limited). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    policyVersion: text('policy_version').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => ({
    userTypeIdx: index('consent_user_type_idx').on(table.userId, table.consentType),
  }),
);

export type ConsentRecord = typeof consentRecords.$inferSelect;
export type NewConsentRecord = typeof consentRecords.$inferInsert;

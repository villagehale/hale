import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-375 — the parent's explicit grant to share named slots with one provider.
 *
 * Written from the inbound "yes, sign us up" message, before a browser types
 * anything and before an assisted handoff repeats a pack. The row stores slot
 * names (child_first_name, parent_email, …), never the values. The message id
 * is the evidence pointer; the message body is not copied here.
 *
 * Immutable. A second insert for the same family, message, activity, and host
 * does not widen or replace the field list.
 */
export const authorizedSignupConsents = pgTable(
  'authorized_signup_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The inbound channel message id. Never the body. */
    messageId: text('message_id').notNull(),
    /** Opaque public activity id. Not a sentence and not a child name. */
    activityKey: text('activity_key').notNull(),
    /** Hostname the share is for, lowercased, no trailing dot. */
    providerHost: text('provider_host').notNull(),
    /** Closed slot names the parent allowed Hale to share. No values. */
    fieldsAllowed: text('fields_allowed').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    grant: uniqueIndex('authorized_signup_consents_grant_uniq').on(
      table.familyId,
      table.messageId,
      table.activityKey,
      table.providerHost,
    ),
    familyIdx: index('authorized_signup_consents_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type AuthorizedSignupConsent = typeof authorizedSignupConsents.$inferSelect;
export type NewAuthorizedSignupConsent = typeof authorizedSignupConsents.$inferInsert;

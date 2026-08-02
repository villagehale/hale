import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { consentRecords } from './consent.js';
import { teenAccessScopeEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-147 · the rule #1 NAMED EXCEPTION, made real: a parent's explicit, logged,
 * time-limited grant to read a 13+ teen's raw content. This table is the
 * ENFORCEMENT source of truth — `activeTeenGrant` reads it on every unlock — while
 * `consent_records` keeps the append-only compliance ledger of the same
 * transitions (the mcp_grants / consentRecords split, reused).
 *
 * The shape encodes the four promises the privacy page makes, so none of them can
 * be satisfied by prose alone:
 *
 *   EXPLICIT      → `reason` is NOT NULL: a parent must say why, in their words.
 *   SCOPED        → `scope` is a closed enum (F14 verdict #8) — never a blanket read.
 *   TIME-LIMITED  → `startsAt`/`expiresAt`, bounded in code to 7 days (24h for a
 *                   safety escalation). Both stay NULL until the grant ACTIVATES,
 *                   so a merely-requested grant can never match the read predicate.
 *   ASSENTED      → `teenAssentAt` (rule #5 teen assent). The ONLY way to activate
 *                   without it is `safetyEscalation`, the rule #1 named exception.
 *
 * `teenNotifiedAt` is the notification OBLIGATION, not an optimisation: NULL means
 * Hale still owes this teen a notification. A teen has no users row and `children`
 * carries no contact column, so v1 records and surfaces the obligation rather than
 * pretending to have delivered it (see requestTeenAccessGrant).
 *
 * Deletes cascade from BOTH the family and the child: a grant is meaningless once
 * either is gone, and leaving an orphan row that still reads "active" would be a
 * standing authorisation to see a person who is no longer in the store.
 */
export const teenAccessGrants = pgTable(
  'teen_access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The 13+ child whose content this grant would unlock. */
    childId: uuid('child_id')
      .notNull()
      .references(() => children.id, { onDelete: 'cascade' }),
    /** The parent who asked — the audit actor, and the ONLY viewer it unlocks for. */
    grantedToUserId: uuid('granted_to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: teenAccessScopeEnum('scope').notNull(),
    /** The parent's stated reason, shown to the teen with the assent ask. */
    reason: text('reason').notNull(),
    /**
     * Rule #1's named exception: a credible risk of harm. Activates WITHOUT teen
     * assent, always notifies, and is held to the shorter window. Never a default.
     */
    safetyEscalation: boolean('safety_escalation').notNull().default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    teenAssentAt: timestamp('teen_assent_at', { withTimezone: true }),
    /** NULL until activation — an inactive window can never satisfy the predicate. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** NULL = Hale still owes this teen the notification rule #1 requires. */
    teenNotifiedAt: timestamp('teen_notified_at', { withTimezone: true }),
    /** The compliance-ledger row this grant's REQUEST wrote (PIPEDA right-to-access). */
    consentRecordId: uuid('consent_record_id').references(() => consentRecords.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The read path: every unlock check is (family, child, scope) at a point in time. */
    lookupIdx: index('teen_access_grants_lookup_idx').on(
      table.familyId,
      table.childId,
      table.scope,
    ),
    /** The parent-facing list, newest first. */
    familyIdx: index('teen_access_grants_family_idx').on(table.familyId, table.requestedAt),
    /** The outstanding-notification sweep — the obligation ledger. */
    owedNotificationIdx: index('teen_access_grants_owed_notification_idx')
      .on(table.familyId)
      .where(sql`${table.teenNotifiedAt} IS NULL`),
  }),
);

export type TeenAccessGrant = typeof teenAccessGrants.$inferSelect;
export type NewTeenAccessGrant = typeof teenAccessGrants.$inferInsert;

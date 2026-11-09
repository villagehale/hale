import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-303 · "that is not something I can do yet", as a row.
 *
 * A refusal is a claim about Hale, and it goes stale the day the capability ships. On
 * 2026-08 a parent was told parks, sleep transitions and the referral link were all past
 * Hale, and each became false within days with nobody telling him. This row is what lets
 * the next text that parent sends carry the correction once.
 *
 * Owned by the PARENT who was told, not the household: a co-parent who never heard the
 * no has nothing to be corrected about. `capability` is a key from the closed registry
 * in apps/web/lib/channel/capabilities/registry.ts, never words.
 *
 * OPEN is `corrected_at IS NULL`. The partial unique index keeps one open denial per
 * parent per capability, so saying no twice owes one correction.
 */
export const capabilityDenials = pgTable(
  'capability_denials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    /** The outbound `channel_messages` id that carried the no. Provenance only. */
    deniedIn: text('denied_in').notNull(),
    deniedAt: timestamp('denied_at', { withTimezone: true }).notNull().defaultNow(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    /** The outbound `channel_messages` id that carried the correction. */
    correctedBy: text('corrected_by'),
  },
  (table) => ({
    closureCheck: check(
      'capability_denials_closure_check',
      sql`(${table.correctedAt} IS NULL) = (${table.correctedBy} IS NULL)`,
    ),
    openUniq: uniqueIndex('capability_denials_open_uniq')
      .on(table.userId, table.capability)
      .where(sql`${table.correctedAt} IS NULL`),
    familyIdx: index('capability_denials_family_idx').on(table.familyId),
  }),
);

export type CapabilityDenial = typeof capabilityDenials.$inferSelect;

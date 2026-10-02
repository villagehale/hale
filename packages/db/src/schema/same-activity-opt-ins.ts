import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-394 — one household's explicit yes to a meet or a join-group for one
 * activity.
 *
 * The row is THIS household's decision. It does not name another household,
 * a child, or a place. `activity_key` is an opaque string the caller already
 * holds for its own activity; it is compared, never parsed, and never turned
 * into a roster of who signed up. A household that booked and did not opt in
 * has no row here, so a reader of this table cannot learn that they go.
 *
 * One live row per household, activity, and kind. A later no sets
 * `revoked_at` rather than deleting the yes, so the withdrawal is a fact
 * (rule #6). The family cascade is the erasure path.
 */
export const sameActivityOptIns = pgTable(
  'same_activity_opt_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The parent who said the word. Their leaving the household ends the yes. */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Opaque. Not a title, not an address, not another family's id. */
    activityKey: text('activity_key').notNull(),
    /** `meet` pairs two households. `join_group` is the set who all said yes. */
    kind: text('kind').notNull(),
    /** Inbound message id. The body is not copied. */
    messageId: text('message_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    liveUniq: uniqueIndex('same_activity_opt_ins_live_uniq')
      .on(table.familyId, table.activityKey, table.kind)
      .where(sql`${table.revokedAt} IS NULL`),
    activityIdx: index('same_activity_opt_ins_activity_idx')
      .on(table.activityKey, table.kind)
      .where(sql`${table.revokedAt} IS NULL`),
    familyIdx: index('same_activity_opt_ins_family_idx').on(table.familyId, table.createdAt),
    activityChk: check(
      'same_activity_opt_ins_activity_chk',
      sql`char_length(${table.activityKey}) BETWEEN 1 AND 200 AND ${table.activityKey} = btrim(${table.activityKey}) AND position(E'\n' IN ${table.activityKey}) = 0 AND position('@' IN ${table.activityKey}) = 0`,
    ),
    kindChk: check('same_activity_opt_ins_kind_chk', sql`${table.kind} IN ('meet', 'join_group')`),
    messageChk: check(
      'same_activity_opt_ins_message_chk',
      sql`char_length(${table.messageId}) BETWEEN 1 AND 200 AND ${table.messageId} = btrim(${table.messageId}) AND position(E'\n' IN ${table.messageId}) = 0`,
    ),
  }),
);

export type SameActivityOptIn = typeof sameActivityOptIns.$inferSelect;
export type NewSameActivityOptIn = typeof sameActivityOptIns.$inferInsert;

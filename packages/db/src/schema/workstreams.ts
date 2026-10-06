import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-419 — threads Hale is in the middle of for one family.
 *
 * Not an identity fact and not an `agent_commitments` promise. A commitment is
 * a debt Hale already spoke. A workstream is the open job: a search still
 * waiting on a pick, a camp that has not written back, a reminder whose pickup
 * is unassigned. The model decides when one opens, moves, finishes, or drops.
 * This table only stores that decision and the caps around it.
 */
export const WORKSTREAM_STATUSES = [
  'open',
  'waiting_on_parent',
  'waiting_on_third_party',
  'scheduled',
  'done',
  'dropped',
] as const;

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export const familyWorkstreams = pgTable(
  'family_workstreams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').notNull().$type<WorkstreamStatus>(),
    nextStep: text('next_step'),
    checkBackAt: timestamp('check_back_at', { withTimezone: true }),
    childIds: uuid('child_ids').array().notNull().default([]),
    eventIds: uuid('event_ids').array().notNull().default([]),
    activityRefs: text('activity_refs').array().notNull().default([]),
    /** The message that opened the thread. */
    createdFrom: text('created_from').notNull(),
    /** The message that last changed it, or `expiry` when the row closed itself. */
    updatedFrom: text('updated_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lastFollowedUpAt: timestamp('last_followed_up_at', { withTimezone: true }),
  },
  (table) => ({
    statusChk: check(
      'family_workstreams_status_chk',
      sql`${table.status} IN ('open', 'waiting_on_parent', 'waiting_on_third_party', 'scheduled', 'done', 'dropped')`,
    ),
    openIdx: index('family_workstreams_open_idx')
      .on(table.familyId, table.updatedAt)
      .where(
        sql`${table.status} IN ('open', 'waiting_on_parent', 'waiting_on_third_party', 'scheduled')`,
      ),
    checkBackIdx: index('family_workstreams_check_back_idx')
      .on(table.checkBackAt)
      .where(
        sql`${table.checkBackAt} IS NOT NULL AND ${table.status} IN ('open', 'waiting_on_parent', 'waiting_on_third_party', 'scheduled')`,
      ),
  }),
);

export type FamilyWorkstream = typeof familyWorkstreams.$inferSelect;
export type NewFamilyWorkstream = typeof familyWorkstreams.$inferInsert;

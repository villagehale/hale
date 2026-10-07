import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-106 — one stamp on a child's interest passport.
 *
 * One row per activity per season (or one visit). A removed row stays, so the
 * same source is not inferred again. `source_subject` is a single-line snippet
 * of at most 180 characters. There is no column for an email body.
 *
 * The family cascade is the erasure path.
 */
export const kidInterests = pgTable(
  'kid_interests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id').references(() => children.id, { onDelete: 'cascade' }),
    activity: text('activity').notNull(),
    activityKey: text('activity_key').notNull(),
    level: text('level'),
    seasonKey: text('season_key').notNull(),
    seasonLabel: text('season_label').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    edited: boolean('edited').notNull().default(false),
    shared: boolean('shared').notNull().default(false),
    sourceType: text('source_type').notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceSubject: text('source_subject'),
    sourceSeenOn: date('source_seen_on'),
    sourceOwnerUserId: uuid('source_owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sharerFirstName: text('sharer_first_name'),
    whenLabel: text('when_label'),
    sessionStart: date('session_start'),
    sessionEnd: date('session_end'),
    weeksTotal: integer('weeks_total'),
    weeksElapsed: integer('weeks_elapsed').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    liveUniq: uniqueIndex('kid_interests_live_uniq')
      .on(table.childId, table.activityKey, table.seasonKey)
      .where(sql`${table.state} <> 'removed' AND ${table.childId} IS NOT NULL`),
    childSourceUniq: uniqueIndex('kid_interests_child_source_uniq')
      .on(table.childId, table.sourceRef)
      .where(sql`${table.childId} IS NOT NULL`),
    unassignedSourceUniq: uniqueIndex('kid_interests_unassigned_source_uniq')
      .on(table.familyId, table.sourceRef)
      .where(sql`${table.childId} IS NULL`),
    familyIdx: index('kid_interests_family_idx').on(table.familyId),
    kindChk: check('kid_interests_kind_chk', sql`${table.kind} IN ('activity', 'outing')`),
    stateChk: check(
      'kid_interests_state_chk',
      sql`${table.state} IN ('inferred', 'confirmed', 'removed')`,
    ),
    sourceTypeChk: check(
      'kid_interests_source_type_chk',
      sql`${table.sourceType} IN ('gmail', 'calendar', 'parent', 'group_share')`,
    ),
  }),
);

/** Household switch. Off means the group sees nothing unless a stamp is shared. */
export const familyInterestSettings = pgTable('family_interest_settings', {
  familyId: uuid('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  shareWithGroup: boolean('share_with_group').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** At most one next-step offer per child per season. */
export const interestNextStepOffers = pgTable(
  'interest_next_step_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id')
      .notNull()
      .references(() => children.id, { onDelete: 'cascade' }),
    seasonKey: text('season_key').notNull(),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    childSeasonUniq: uniqueIndex('interest_next_step_offers_child_season_uniq').on(
      table.childId,
      table.seasonKey,
    ),
  }),
);

/** Grade, notes, and when the school day ends. Age stays derived from date of birth. */
export const kidPassportProfiles = pgTable('kid_passport_profiles', {
  childId: uuid('child_id')
    .primaryKey()
    .references(() => children.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id')
    .notNull()
    .references(() => families.id, { onDelete: 'cascade' }),
  grade: text('grade'),
  notes: text('notes'),
  schoolDayEnds: text('school_day_ends'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type KidInterest = typeof kidInterests.$inferSelect;
export type NewKidInterest = typeof kidInterests.$inferInsert;
export type FamilyInterestSettings = typeof familyInterestSettings.$inferSelect;
export type KidPassportProfile = typeof kidPassportProfiles.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Group onboarding v2 — who is in a family's Linq group, read from GET /chats/{id}.
 *
 * One roster per chat. `family_id` is null until a parent Hale already knows is
 * matched: a `no_family`, `mixed_family`, `not_group` or `roster_pending` roster belongs
 * to nobody.
 * Nothing here is a seat. A seat is still a `linq_group_members` row, written only on
 * the person's own reply; a member row records what was read and asked.
 */
export const LINQ_GROUP_ROSTER_SOURCES = ['added_to_existing', 'new_group', 'backfill'] as const;
export type LinqGroupRosterSource = (typeof LINQ_GROUP_ROSTER_SOURCES)[number];

export const LINQ_GROUP_ROSTER_STATUSES = [
  'roster_pending',
  'no_family',
  'mixed_family',
  'roles_proposed',
  'partial',
  'confirmed',
  'refused',
  'ejected',
  'not_group',
] as const;
export type LinqGroupRosterStatus = (typeof LINQ_GROUP_ROSTER_STATUSES)[number];

/** A wording hint for the ask, never stated as fact and never a seat. */
export const LINQ_ROSTER_PROPOSED_ROLES = [
  'parent',
  'grandparent',
  'nanny',
  'babysitter',
  'unknown',
] as const;
export type LinqRosterProposedRole = (typeof LINQ_ROSTER_PROPOSED_ROLES)[number];

export const LINQ_ROSTER_MEMBER_STATUSES = [
  'known_parent',
  'proposed',
  'asked',
  'reasked',
  'confirmed',
  'declined',
  'not_family',
  'refused',
  'left',
  'removed',
] as const;
export type LinqRosterMemberStatus = (typeof LINQ_ROSTER_MEMBER_STATUSES)[number];

/**
 * Scoped seats, plus `extended` for an aunt, uncle, or cousin who said they are
 * family. `service` is never granted. `extended` is family, not `not_family`.
 */
export const LINQ_ROSTER_CONFIRMED_ROLES = [
  'co_parent',
  'grandparent',
  'nanny',
  'babysitter',
  'extended',
] as const;
export type LinqRosterConfirmedRole = (typeof LINQ_ROSTER_CONFIRMED_ROLES)[number];

export const LINQ_ROSTER_CONNECT_STEPS = ['none', 'link_sent', 'unreachable', 'done'] as const;
export type LinqRosterConnectStep = (typeof LINQ_ROSTER_CONNECT_STEPS)[number];

export const linqGroupRosters = pgTable(
  'linq_group_rosters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
    source: text('source').notNull().$type<LinqGroupRosterSource>(),
    status: text('status').notNull().$type<LinqGroupRosterStatus>(),
    memberCount: integer('member_count'),
    rosterFetchedAt: timestamp('roster_fetched_at', { withTimezone: true }),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ejectedAt: timestamp('ejected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceCheck: check(
      'linq_group_rosters_source_check',
      sql`${table.source} in ('added_to_existing', 'new_group', 'backfill')`,
    ),
    statusCheck: check(
      'linq_group_rosters_status_check',
      sql`${table.status} in ('roster_pending', 'no_family', 'mixed_family', 'roles_proposed', 'partial', 'confirmed', 'refused', 'ejected', 'not_group')`,
    ),
    chatUniq: uniqueIndex('linq_group_rosters_chat_uniq').on(table.chatId),
    familyIdx: index('linq_group_rosters_family_idx').on(table.familyId),
  }),
);

export const linqGroupRosterMembers = pgTable(
  'linq_group_roster_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rosterId: uuid('roster_id')
      .notNull()
      .references(() => linqGroupRosters.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    /** Null once the retention sweep released it (0159); the hash is kept. */
    phoneE164Encrypted: text('phone_e164_encrypted'),
    phoneE164Hash: text('phone_e164_hash').notNull(),
    knownUserId: uuid('known_user_id').references(() => users.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    proposedRole: text('proposed_role')
      .notNull()
      .default('unknown')
      .$type<LinqRosterProposedRole>(),
    status: text('status').notNull().$type<LinqRosterMemberStatus>(),
    confirmedRole: text('confirmed_role').$type<LinqRosterConfirmedRole>(),
    connectStep: text('connect_step').notNull().default('none').$type<LinqRosterConnectStep>(),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposedRoleCheck: check(
      'linq_group_roster_members_proposed_role_check',
      sql`${table.proposedRole} in ('parent', 'grandparent', 'nanny', 'babysitter', 'unknown')`,
    ),
    statusCheck: check(
      'linq_group_roster_members_status_check',
      sql`${table.status} in ('known_parent', 'proposed', 'asked', 'reasked', 'confirmed', 'declined', 'not_family', 'refused', 'left', 'removed')`,
    ),
    confirmedRoleCheck: check(
      'linq_group_roster_members_confirmed_role_check',
      sql`${table.confirmedRole} in ('co_parent', 'grandparent', 'nanny', 'babysitter', 'extended')`,
    ),
    connectStepCheck: check(
      'linq_group_roster_members_connect_step_check',
      sql`${table.connectStep} in ('none', 'link_sent', 'unreachable', 'done')`,
    ),
    liveChatPhone: uniqueIndex('linq_group_roster_members_live_uniq')
      .on(table.chatId, table.phoneE164Hash)
      .where(sql`${table.status} NOT IN ('left', 'removed')`),
    rosterIdx: index('linq_group_roster_members_roster_idx').on(table.rosterId),
    phoneIdx: index('linq_group_roster_members_phone_idx').on(table.phoneE164Hash),
  }),
);

export type LinqGroupRoster = typeof linqGroupRosters.$inferSelect;
export type NewLinqGroupRoster = typeof linqGroupRosters.$inferInsert;
export type LinqGroupRosterMember = typeof linqGroupRosterMembers.$inferSelect;
export type NewLinqGroupRosterMember = typeof linqGroupRosterMembers.$inferInsert;

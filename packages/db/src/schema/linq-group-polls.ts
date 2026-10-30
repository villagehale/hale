import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/** One choice on a group poll. `key` is opaque (`o1`, `o2`, …) so the reader never sees ids. */
export interface LinqGroupPollOptionJson {
  key: string;
  text: string;
  /** Linq's option id when the choice is on a native poll card, otherwise null. */
  providerOptionId: string | null;
}

export interface LinqGroupPollExpectedJson {
  memberKey: string;
  displayName: string;
}

export const GROUP_POLL_ORIGINS = ['parent', 'hale_offer'] as const;
export type GroupPollOrigin = (typeof GROUP_POLL_ORIGINS)[number];

export const GROUP_POLL_VOTE_SOURCES = ['text', 'native'] as const;
export type GroupPollVoteSource = (typeof GROUP_POLL_VOTE_SOURCES)[number];

/**
 * VIL-471 — one live poll in a Linq group chat.
 *
 * `parent` polls are made when a parent asks Hale in the group. `hale_offer`
 * polls are adopted from a native card Hale already sent (the VIL-458 stuck
 * offer) the first time someone votes on it. A chat has at most one live poll;
 * a new one closes the last. `expected` is who Hale is waiting on.
 */
export const linqGroupPolls = pgTable(
  'linq_group_polls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    question: text('question'),
    options: jsonb('options').$type<LinqGroupPollOptionJson[]>().notNull(),
    expected: jsonb('expected').$type<LinqGroupPollExpectedJson[]>().notNull().default([]),
    providerMessageId: text('provider_message_id'),
    origin: text('origin').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    originCheck: check(
      'linq_group_polls_origin_check',
      sql`${table.origin} in ('parent', 'hale_offer')`,
    ),
    liveChatUniq: uniqueIndex('linq_group_polls_live_chat_uniq')
      .on(table.chatId)
      .where(sql`${table.closedAt} IS NULL`),
    providerMessageIdx: index('linq_group_polls_provider_message_idx').on(table.providerMessageId),
    familyIdx: index('linq_group_polls_family_idx').on(table.familyId),
  }),
);

/**
 * One person's current pick on a group poll. Re-voting UPDATES the row on
 * (poll_id, member_key), so a changed mind never counts twice. No message text
 * is stored — only the option key.
 */
export const linqGroupPollVotes = pgTable(
  'linq_group_poll_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => linqGroupPolls.id, { onDelete: 'cascade' }),
    memberKey: text('member_key').notNull(),
    displayName: text('display_name').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    haleCustomer: text('hale_customer').notNull().default('false'),
    optionKey: text('option_key').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceCheck: check(
      'linq_group_poll_votes_source_check',
      sql`${table.source} in ('text', 'native')`,
    ),
    haleCustomerCheck: check(
      'linq_group_poll_votes_hale_customer_check',
      sql`${table.haleCustomer} in ('true', 'false')`,
    ),
    pollMemberUniq: uniqueIndex('linq_group_poll_votes_poll_member_uniq').on(
      table.pollId,
      table.memberKey,
    ),
    pollIdx: index('linq_group_poll_votes_poll_idx').on(table.pollId),
  }),
);

export type LinqGroupPoll = typeof linqGroupPolls.$inferSelect;
export type NewLinqGroupPoll = typeof linqGroupPolls.$inferInsert;
export type LinqGroupPollVote = typeof linqGroupPollVotes.$inferSelect;

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';

/**
 * How long a kept question, and what it was missing, may be. A question a parent texted
 * and Hale could not answer yet is a sentence, and what it lacked is a few words; a
 * longer one is not kept at all (apps/web/lib/channel/off-domain/answer.ts). THESE ARE
 * THE SOURCE: migration 0167's two CHECKs restate them in SQL.
 */
export const PENDING_ASK_QUESTION_MAX_CHARS = 500;
export const PENDING_ASK_MISSING_MAX_CHARS = 200;

/**
 * The question a general answer left open, beside the reply that left it (migration
 * 0167). One row per such reply, keyed by that OUTBOUND channel_messages row.
 *
 * A table of its own, not columns on channel_messages: every insert into that table
 * names every column, so two columns there would have had to exist before any code that
 * knew of them could send a text. The lane neither reads nor writes this table while
 * GENERAL_ANSWER_SEARCH_ENABLED is dark; the hourly retention sweep is its one other
 * reader, and finds it empty.
 *
 * DE-IDENTIFIED (rule #1): `question` is the sanitizer's rewrite with the family taken
 * out and a deterministic identifier scrub under it, and `missing` what it lacked, in a
 * few words. Never the parent's own words, and never what Hale said.
 *
 * IT LIVES ONLY WHILE IT IS OPEN. A question stands while its reply is Hale's last word
 * to that parent, and the next reply Hale sends them deletes it (lane.ts). The hourly
 * retention sweep deletes one that any other newer word from Hale has closed, and one a
 * year old. Both cascades are the erasure path: the family's, and the reply row's.
 */
export const channelPendingAsks = pgTable(
  'channel_pending_asks',
  {
    channelMessageId: uuid('channel_message_id')
      .primaryKey()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    missing: text('missing').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('channel_pending_asks_family_idx').on(table.familyId),
    questionLengthChk: check(
      'channel_pending_asks_question_length_check',
      sql`char_length(${table.question}) <= ${sql.raw(String(PENDING_ASK_QUESTION_MAX_CHARS))}`,
    ),
    missingLengthChk: check(
      'channel_pending_asks_missing_length_check',
      sql`char_length(${table.missing}) <= ${sql.raw(String(PENDING_ASK_MISSING_MAX_CHARS))}`,
    ),
  }),
);

export type ChannelPendingAsk = typeof channelPendingAsks.$inferSelect;
export type NewChannelPendingAsk = typeof channelPendingAsks.$inferInsert;

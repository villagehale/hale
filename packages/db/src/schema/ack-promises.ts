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
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-717 · the time Hale told a parent to expect an answer, as a row.
 *
 * A slow 1:1 ask (a registration, research, a find) gets an ack that says what Hale is
 * doing and when the parent will hear back. That sentence is a promise with a clock on
 * it, so it is written down against the outbound row that carried it (send-time only:
 * a compose that never reached a transport promised nobody anything). A sweep on the
 * scheduled drain reads the rows that came due and, when the reply to that text never
 * landed, sends ONE short note saying so.
 *
 * WHAT IS DELIBERATELY NOT HERE: the parent's words, the ack's words, the note's words, a
 * phone number. The task is a closed category and the times are times. The words live
 * where every reply's words live (`messages`), and the number is read from the parent's
 * live channel at send time, so a revoked channel cannot be texted from a stale copy.
 *
 * ONCE PER TEXT, by construction: the unique index on the inbound row means one text
 * carries at most one promise, and `claimed_at` is the sweep's claim, taken with a
 * conditional update before anything is composed, so two sweeps cannot both send a note.
 *
 * Rows are kept seven days after they settle and then deleted by the sweep itself. Erasure
 * cascades from the family, the parent, and either message row.
 */

/** What the ack said Hale was doing. Mirrors `AckTask` in apps/web/lib/channel/ack-eta. */
export const ACK_PROMISE_TASKS = ['registration', 'research', 'find'] as const;
export type AckPromiseTask = (typeof ACK_PROMISE_TASKS)[number];

/**
 * How a promise that came due was settled (rule #11: every ending is named).
 *
 * `answered`: the reply to that text landed, so nothing was owed. `sent`: the late note
 * went. `lane_off`: the flag was off when it came due. `stale`: the sweep reached it too
 * long after it came due for a note to mean anything. `held`: a send rail stopped the note
 * (sends paused, no live channel, an unread opt-out). `unwritten`: the model could not
 * write a sendable note, nothing was sent and #ops was paged. `send_failed`: the transport
 * refused it.
 */
export const ACK_PROMISE_OUTCOMES = [
  'answered',
  'sent',
  'lane_off',
  'stale',
  'held',
  'unwritten',
  'send_failed',
] as const;
export type AckPromiseOutcome = (typeof ACK_PROMISE_OUTCOMES)[number];

export const ackPromises = pgTable(
  'ack_promises',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The adult who asked, and the only one the note may go to. */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The parent's text the promise answers. One promise per text. */
    inboundChannelMessageId: uuid('inbound_channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    /** The outbound ack that carried the promise (send-time only). */
    ackChannelMessageId: uuid('ack_channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    /** A member of {@link ACK_PROMISE_TASKS}: a category, never content. */
    task: text('task').notNull(),
    /** The door the ask came in on, which is the door the note goes out on. */
    channel: text('channel').notNull(),
    /** The Linq chat of a 1:1 iMessage ask, so the note returns to it. Null on SMS. */
    providerChatId: text('provider_chat_id'),
    /** The parent's own Linq message id, so the note threads under the ask. */
    replyToMessageId: text('reply_to_message_id'),
    /** The BCP-47 tag the ack was written in, so the note is written in it too. */
    language: text('language'),
    /** When the parent's text arrived. The retry ceiling is counted from here. */
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull(),
    /** The window the ack stated, in minutes. */
    promisedMinutes: integer('promised_minutes').notNull(),
    /** When the stated window ends: the ack's send time plus {@link promisedMinutes}. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The sweep's claim, taken before anything is composed. Once set, never again. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** A member of {@link ACK_PROMISE_OUTCOMES}. Paired with `settled_at`. */
    outcome: text('outcome'),
    /** The late note's outbound row, when one went. */
    noteChannelMessageId: uuid('note_channel_message_id').references(() => channelMessages.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    inboundUniq: uniqueIndex('ack_promises_inbound_uniq').on(table.inboundChannelMessageId),
    // The sweep's scan: the handful of promises nobody has claimed yet, by due time.
    openDueIdx: index('ack_promises_open_due_idx')
      .on(table.dueAt)
      .where(sql`${table.claimedAt} IS NULL`),
    familyIdx: index('ack_promises_family_idx').on(table.familyId, table.createdAt),
    taskChk: check(
      'ack_promises_task_check',
      sql`${table.task} IN ('registration', 'research', 'find')`,
    ),
    channelChk: check('ack_promises_channel_check', sql`${table.channel} IN ('sms', 'imessage')`),
    minutesChk: check('ack_promises_minutes_check', sql`${table.promisedMinutes} > 0`),
    outcomeChk: check(
      'ack_promises_outcome_check',
      sql`(${table.outcome} IS NULL) = (${table.settledAt} IS NULL)
          AND (${table.outcome} IS NULL OR ${table.outcome} IN ('answered', 'sent', 'lane_off', 'stale', 'held', 'unwritten', 'send_failed'))`,
    ),
  }),
);

export type AckPromise = typeof ackPromises.$inferSelect;
export type NewAckPromise = typeof ackPromises.$inferInsert;

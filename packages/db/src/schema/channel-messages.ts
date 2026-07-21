import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actions } from './actions.js';
import { conversations } from './conversations.js';
import {
  channelMessageCategoryEnum,
  channelMessageChannelEnum,
  channelMessageDirectionEnum,
  channelMessageStatusEnum,
} from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * F11 · The Sunday Loop — channel_messages (VIL-213 · A2). The NEW operational
 * system-of-record for LOOP messages only, in both directions and for EVERY
 * outcome (a delivered/failed send OR a suppression). One row per delivery leg.
 *
 * Relationship to the existing ledgers (scout decision, do not blur):
 *   - email_sends stays the CASL legal sub-ledger — a loop EMAIL writes BOTH this
 *     row and an email_sends row (and honors the email opt-out).
 *   - outbound_sends (executor exactly-once) and push_sends (legacy debounce) are
 *     a different domain and are UNTOUCHED.
 *
 * `body` is nullable and populated for direction:'in' ONLY — the verbatim inbound
 * reply, which C3 treats as the approval's legal instrument (locked cross-ticket
 * contract). Outbound rows never store a rendered body: it is reconstructable from
 * template + payload, and storing rendered child-data is a liability (rule #1).
 */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: channelMessageChannelEnum('channel').notNull(),
    direction: channelMessageDirectionEnum('direction').notNull().default('out'),
    category: channelMessageCategoryEnum('category').notNull(),
    /** The template that produced (or would have produced) this message. Null for
     * inbound replies, which have no template. */
    templateKey: text('template_key'),
    /** Natural-identity idempotency key (e.g. family+week+template). Unique where
     * present, so a re-drain can never double-send the same logical message. */
    dedupeKey: text('dedupe_key'),
    /** The provider's id for the send. Indexed — A3's delivery-status callbacks
     * update `status` by looking a row up on it. */
    providerMessageId: text('provider_message_id'),
    status: channelMessageStatusEnum('status').notNull(),
    errorCode: text('error_code'),
    /** Verbatim body — direction:'in' ONLY (A3 writes it; C3's legal instrument).
     * Outbound rows leave this null (rule #1). */
    body: text('body'),
    relatedActionId: uuid('related_action_id').references(() => actions.id, {
      onDelete: 'set null',
    }),
    relatedConversationId: uuid('related_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A present dedupe_key is unique — the idempotency guard the drain relies on.
    dedupeKeyUniq: uniqueIndex('channel_messages_dedupe_key_uniq')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    // Status callbacks resolve a row by the provider's id.
    providerIdx: index('channel_messages_provider_msg_idx').on(table.providerMessageId),
    // Cap counting: recent rows for a parent + category.
    capIdx: index('channel_messages_cap_idx').on(
      table.parentUserId,
      table.category,
      table.createdAt,
    ),
  }),
);

export type ChannelMessageRow = typeof channelMessages.$inferSelect;
export type NewChannelMessageRow = typeof channelMessages.$inferInsert;

import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { families } from './families.js';

/**
 * Multi-turn Ask Hale threads. A conversation is a family-scoped container; its
 * messages are the running transcript the agent re-reads to keep context across
 * turns. Family-scoped (rule #1: a thread belongs to exactly one family — its
 * messages are never visible to another). The transcript carries only what the
 * parent typed and Hale's plain-prose answers; raw child content never enters it
 * (the teen-redaction guard runs upstream at the tool boundary).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('conversations_family_idx').on(table.familyId),
  }),
);

/**
 * One turn in a conversation — a parent question (`user`) or Hale's answer
 * (`assistant`). Append-only; the (conversation_id, created_at) index serves the
 * in-order replay the agent reads to ground each new turn.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationTimeIdx: index('messages_conversation_time_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    roleCheck: check('messages_role_check', sql`${table.role} IN ('user', 'assistant')`),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

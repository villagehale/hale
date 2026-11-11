import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-399 — live group-chat experience state (RSVP/time polls, a posted link,
 * a mail notice, a private question Hale moved 1:1).
 *
 * One live row per (chat, kind, subject). Closing sets `closed_at` rather than
 * deleting, so the moment stays a fact. The family cascade is the erasure path.
 * `payload` is code-owned facts (option keys, a URL, a poll id) — never a
 * parent-facing sentence.
 */
export const GROUP_EXPERIENCE_KINDS = [
  'rsvp_poll',
  'time_poll',
  'link_card',
  'mail_notice',
  'private_question',
] as const;
export type GroupExperienceKind = (typeof GROUP_EXPERIENCE_KINDS)[number];

export const linqGroupExperience = pgTable(
  'linq_group_experience',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    liveUniq: uniqueIndex('linq_group_experience_live_uniq')
      .on(table.chatId, table.kind, table.subjectKey)
      .where(sql`${table.closedAt} IS NULL`),
    chatIdx: index('linq_group_experience_chat_idx').on(table.chatId, table.kind),
    familyIdx: index('linq_group_experience_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type LinqGroupExperience = typeof linqGroupExperience.$inferSelect;
export type NewLinqGroupExperience = typeof linqGroupExperience.$inferInsert;

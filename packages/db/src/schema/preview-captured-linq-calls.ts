import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * VIL-466 groups · Every partner call a Preview capture run made to a fake group
 * chat instead of reaching Linq: group messages, tapbacks, polls, typing, read
 * receipts, chat create/update, and the roster the fake inbound door seeded.
 *
 * Written only on a Vercel Preview deploy with PREVIEW_CAPTURE_TRANSPORT=on,
 * PREVIEW_CAPTURE_GROUPS=on and no Linq key or line, and only for `preview-chat-…`
 * chats whose handles are all in the fictional +1 437-555 range. Production never
 * writes here.
 */
export const previewCapturedLinqCalls = pgTable(
  'preview_captured_linq_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    kind: text('kind').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    body: jsonb('body'),
    handles: jsonb('handles').$type<string[]>(),
    providerMessageId: text('provider_message_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chatIdx: index('preview_captured_linq_calls_chat_idx').on(t.chatId, t.capturedAt),
  }),
);

export type PreviewCapturedLinqCall = typeof previewCapturedLinqCalls.$inferSelect;

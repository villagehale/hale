import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * VIL-466 · What the Preview capture transport recorded instead of sending.
 *
 * Only a Vercel Preview deploy with `PREVIEW_CAPTURE_TRANSPORT=on` and no Linq
 * key or line writes a row, and only for the fictional +1 437-555 probe range.
 * Production never writes here. The body is kept so a fake-family proof run can
 * be read back word for word; no real parent's message can reach this table.
 */
export const previewCapturedSends = pgTable(
  'preview_captured_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toE164: text('to_e164').notNull(),
    body: text('body').notNull(),
    mediaUrls: jsonb('media_urls').$type<string[]>(),
    /** VIL-474 · Linq text decorations the send carried (bold ranges). Null when none. */
    decorations:
      jsonb('decorations').$type<
        { range: readonly [number, number]; style?: string; animation?: string }[]
      >(),
    providerMessageId: text('provider_message_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    toIdx: index('preview_captured_sends_to_idx').on(t.toE164, t.capturedAt),
  }),
);

export type PreviewCapturedSend = typeof previewCapturedSends.$inferSelect;

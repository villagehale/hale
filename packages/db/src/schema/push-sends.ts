import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * Per-family push-send ledger: one row per fired push, keyed by (family, kind).
 * The send path checks "did this family already get a push of this kind today?"
 * against this ledger BEFORE addressing any device — the once-per-family-per-day
 * debounce. Cheaper and more honest than scanning the append-only audit_log; the
 * audit_log row (rule #6) still records each send (category + child-id reference,
 * never the body text), while this ledger is only the debounce source of truth.
 *
 * `kind` is the push stream: 'new_picks' | 'health_reminder'. Privacy (rule #1):
 * this holds no child content — only the family id, the coarse stream label, and
 * the send time.
 */
export const pushSends = pgTable(
  'push_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyKindTimeIdx: index('push_sends_family_kind_time_idx').on(
      table.familyId,
      table.kind,
      table.sentAt,
    ),
  }),
);

export type PushSend = typeof pushSends.$inferSelect;
export type NewPushSend = typeof pushSends.$inferInsert;

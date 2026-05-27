import {
  pgTable,
  uuid,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { eventStatusEnum } from './enums.js';

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    /** Provider-side id used for additional dedup (Gmail message id, etc). */
    sourceExternalId: text('source_external_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Pointer to raw signal in object storage; we don't persist heavy blobs in Postgres. */
    rawSignalRef: text('raw_signal_ref'),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    classifierConfidence: doublePrecision('classifier_confidence'),
    /** sha256 of normalized content + sender + family — prevents reprocessing. */
    dedupHash: text('dedup_hash').notNull(),
    status: eventStatusEnum('status').notNull().default('pending'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyStatusIdx: index('events_family_status_idx').on(
      table.familyId,
      table.status,
      table.classifiedAt,
    ),
    dedupIdx: uniqueIndex('events_dedup_idx').on(table.familyId, table.dedupHash),
  }),
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

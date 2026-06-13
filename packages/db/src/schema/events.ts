import {
  pgTable,
  uuid,
  text,
  jsonb,
  doublePrecision,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { children } from './children.js';
import { eventStatusEnum } from './enums.js';

/**
 * Classifier's routing suggestion. Structurally mirrors @hearth/types
 * ClassifierSuggestion; defined locally because @hearth/db is a leaf package and
 * must not depend on @hearth/types (would create a cycle).
 */
type ClassifierSuggestion =
  | { kind: 'autonomous_action'; actionType: string }
  | { kind: 'surface_only' }
  | { kind: 'ignore' }
  | { kind: 'needs_human' };

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
    /** Which child this event concerns, when the classifier could determine it
     * (name match against the family's children, or age/stage cues). Null when
     * undeterminable or family-wide — makes per-child digest grouping possible
     * without forcing every event to belong to a child. ON DELETE SET NULL: a
     * removed child must not cascade-delete the family's event history. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Classifier's routing suggestion, persisted so a crash-resume can route
     * without re-running the (billable) classifier — B10 re-entrancy. */
    classifierSuggestion: jsonb('classifier_suggestion').$type<ClassifierSuggestion>(),
    /** Teen-content flag from the classifier (teenager-pack redaction rule).
     * Persisted so a crash-resume re-applies the rule-#1 teen-redaction cap with
     * the same value the fresh pass saw — without it, a resume reads false and an
     * autonomous-eligible teen-content action could slip the cap. */
    teenContent: boolean('teen_content').notNull().default(false),
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

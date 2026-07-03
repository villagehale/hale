import {
  pgTable,
  uuid,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { families } from './families.js';
import { children } from './children.js';
import { users } from './users.js';
import { memoryFactTypeEnum } from './enums.js';

/**
 * Normalized core facts the agents need fast.
 * Hybrid model: indexable axes here, long-tail attributes in fact_value_json.
 */
export const familyMemoryFacts = pgTable(
  'family_memory_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id').references(() => children.id, { onDelete: 'cascade' }),
    factType: memoryFactTypeEnum('fact_type').notNull(),
    factKey: text('fact_key').notNull(),
    factValue: jsonb('fact_value').$type<unknown>().notNull(),
    confidence: doublePrecision('confidence').notNull().default(1),
    sourceEventId: uuid('source_event_id'),
    inferredBy: text('inferred_by'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Hot path: agent reads facts by (family, type, key) where still valid
    lookupIdx: index('memory_facts_lookup_idx')
      .on(table.familyId, table.factType, table.factKey)
      .where(sql`${table.validUntil} IS NULL`),
    childIdx: index('memory_facts_child_idx').on(table.childId),
  }),
);

/**
 * Episodic memory: things that happened, scanned by Coach and Memory Inferencer.
 */
export const familyMemoryEpisodes = pgTable(
  'family_memory_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id').references(() => children.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    episodeType: text('episode_type').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    sourceEventId: uuid('source_event_id'),
    sentimentScore: doublePrecision('sentiment_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft delete (rule #6 / #9): a parent-removed episode is stamped, not erased,
    // so the audit trail that references it stays intact. NULL = live.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    familyTimeIdx: index('memory_episodes_family_time_idx').on(table.familyId, table.occurredAt),
    familyDeletedIdx: index('memory_episodes_family_deleted_idx').on(
      table.familyId,
      table.deletedAt,
    ),
  }),
);

/**
 * How each parent writes (for Drafter to match voice).
 */
export const familyVoiceProfiles = pgTable(
  'family_voice_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    voiceSamples: jsonb('voice_samples')
      .$type<Array<{ context: string; sample: string }>>()
      .notNull()
      .default([]),
    toneDescriptors: text('tone_descriptors').array().notNull().default([]),
    signatureBlock: text('signature_block'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyUserIdx: index('voice_profile_family_user_idx').on(table.familyId, table.userId),
  }),
);

export type FamilyMemoryFact = typeof familyMemoryFacts.$inferSelect;
export type NewFamilyMemoryFact = typeof familyMemoryFacts.$inferInsert;
export type FamilyMemoryEpisode = typeof familyMemoryEpisodes.$inferSelect;
export type NewFamilyMemoryEpisode = typeof familyMemoryEpisodes.$inferInsert;
export type FamilyVoiceProfile = typeof familyVoiceProfiles.$inferSelect;
export type NewFamilyVoiceProfile = typeof familyVoiceProfiles.$inferInsert;

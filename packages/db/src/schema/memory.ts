import { sql } from 'drizzle-orm';
import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { memoryFactTypeEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

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
    // NOT DECLARED HERE, deliberately: `memory_facts_one_live_per_key_idx` (migration
    // 0084) is a partial UNIQUE index on (family_id, child_id, fact_type, fact_key)
    // WHERE valid_until IS NULL, with NULLS NOT DISTINCT so family-wide facts are
    // covered too. Drizzle's index builder cannot express NULLS NOT DISTINCT (only
    // `unique()` constraints can, and those cannot be partial), so declaring it as a
    // plain uniqueIndex would MISdescribe the live object — nulls-distinct, which
    // exempts most of the table. It lives in hand-written SQL; `writeFact`
    // (apps/web/lib/memory/facts.ts) is the writer that satisfies it.
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
    // Who wrote this episode. A parent quick-log stamps the acting parent's user
    // id; content that arrives via the inbound pipeline (teen-authored) leaves it
    // NULL. The teen-redaction read filter (rule #1) EXEMPTS a row authored BY the
    // requesting parent — a parent's own log about their teen is their own content
    // (policy: parent-authored is exempt), never dropped from that parent.
    authoredBy: uuid('authored_by').references(() => users.id, { onDelete: 'set null' }),
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
 * Alias index for lexical memory search. Tokens are derived from a fact KEY plus a
 * closed synonym lexicon — never from message text — so untrusted content cannot
 * plant a searchable instruction. Rows cascade with the fact and the family.
 */
export const familyMemoryAliases = pgTable(
  'family_memory_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    factId: uuid('fact_id')
      .notNull()
      .references(() => familyMemoryFacts.id, { onDelete: 'cascade' }),
    /** Normalized token: lowercase [a-z0-9] only. */
    aliasNorm: text('alias_norm').notNull(),
    /** `key` when the token is in the fact key; `lexicon` when it is a synonym. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    factAliasUniq: uniqueIndex('family_memory_aliases_fact_alias_uniq').on(
      table.factId,
      table.aliasNorm,
    ),
    lookupIdx: index('family_memory_aliases_lookup_idx').on(table.familyId, table.aliasNorm),
  }),
);

/**
 * Daily and weekly memory rollups. Identity is (family, grain, period_start) in the
 * parent's timezone, so a re-run refreshes one row instead of appending another.
 * `summary` is counts and closed-vocabulary labels — never a message body.
 */
export const familyMemoryDigests = pgTable(
  'family_memory_digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    grain: text('grain').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    timezone: text('timezone').notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    sourceCount: integer('source_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUniq: uniqueIndex('family_memory_digests_identity_uniq').on(
      table.familyId,
      table.grain,
      table.periodStart,
    ),
    familyIdx: index('family_memory_digests_family_idx').on(
      table.familyId,
      table.grain,
      table.periodStart,
    ),
  }),
);

export type FamilyMemoryFact = typeof familyMemoryFacts.$inferSelect;
export type NewFamilyMemoryFact = typeof familyMemoryFacts.$inferInsert;
export type FamilyMemoryEpisode = typeof familyMemoryEpisodes.$inferSelect;
export type NewFamilyMemoryEpisode = typeof familyMemoryEpisodes.$inferInsert;
export type FamilyMemoryAlias = typeof familyMemoryAliases.$inferSelect;
export type FamilyMemoryDigest = typeof familyMemoryDigests.$inferSelect;

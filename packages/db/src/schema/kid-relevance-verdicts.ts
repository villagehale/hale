import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { integrations } from './integrations.js';

/**
 * VIL-226 / VIL-403. One verdict per connector item: is this about the kids?
 *
 * The item is named by its connector key only (a Google series or event id, a Gmail
 * message id, a hash of a group title), never by its title, place or sender (rule #1).
 * `reason` is kept only for a non-teen kid verdict; the CHECK makes that a fact.
 * `hint` is the kind of thing a parent said is theirs, kept only on that parent `adult`
 * row and read only by the judge - never a family memory fact (second CHECK).
 *
 * `inputHash` is the cache key: a model verdict is reused while the hash matches. A
 * `parent` row is the parent's own word and a model upsert never overwrites it.
 *
 * NOT DECLARED HERE, deliberately: `kid_relevance_verdicts_item_uniq` (migration 0164)
 * is a UNIQUE index on (family_id, source, integration_id, item_key) with NULLS NOT
 * DISTINCT, so a group item with no integration is covered too. Drizzle's index builder
 * cannot express NULLS NOT DISTINCT, and a plain uniqueIndex would misdescribe it. Upserts
 * name the four columns as their conflict target and Postgres infers the index.
 */
export const kidRelevanceVerdicts = pgTable(
  'kid_relevance_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    source: text('source').$type<'google_calendar' | 'gmail' | 'group'>().notNull(),
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'cascade',
    }),
    itemKey: text('item_key').notNull(),
    inputHash: text('input_hash').notNull(),
    verdict: text('verdict').$type<'kid' | 'adult' | 'unsure'>().notNull(),
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    teen: boolean('teen').notNull().default(false),
    reason: text('reason'),
    hint: text('hint'),
    decidedBy: text('decided_by').$type<'model' | 'parent'>().notNull(),
    model: text('model'),
    skillHash: text('skill_hash'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceCheck: check(
      'kid_relevance_verdicts_source_chk',
      sql`${table.source} IN ('google_calendar', 'gmail', 'group')`,
    ),
    verdictCheck: check(
      'kid_relevance_verdicts_verdict_chk',
      sql`${table.verdict} IN ('kid', 'adult', 'unsure')`,
    ),
    decidedByCheck: check(
      'kid_relevance_verdicts_decided_by_chk',
      sql`${table.decidedBy} IN ('model', 'parent')`,
    ),
    reasonCheck: check(
      'kid_relevance_verdicts_reason_chk',
      sql`${table.reason} IS NULL OR (${table.verdict} = 'kid' AND NOT ${table.teen})`,
    ),
    hintCheck: check(
      'kid_relevance_verdicts_hint_chk',
      sql`${table.hint} IS NULL OR (${table.decidedBy} = 'parent' AND ${table.verdict} = 'adult')`,
    ),
  }),
);

export type KidRelevanceVerdict = typeof kidRelevanceVerdicts.$inferSelect;
export type NewKidRelevanceVerdict = typeof kidRelevanceVerdicts.$inferInsert;

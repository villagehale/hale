import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * VIL-597 · the one way a prompt reads family memory.
 *
 * Every agent that puts family facts or episodes into a prompt (the coach, the memory
 * brief, the drafter, the find slice, the plan composer, the nightly inferencer) reads
 * through {@link factsForContext} and {@link episodesForContext}. Before this each kept
 * its own query, and they drifted: the coach had no expiry or confidence filter,
 * deleted episodes reached the coach and the drafter, and the drafter had no teen filter
 * and no limit.
 *
 * What never reaches a prompt:
 *   - a fact that is no longer true (`valid_until` set) or whose `expires_at` passed;
 *   - a fact below {@link MEMORY_CONFIDENCE_FLOOR};
 *   - a fact older than its source's window ({@link FACT_FRESH_DAYS}, VIL-519). Past
 *     the window it is not true enough to reason from, so it never eats the limit either;
 *   - a fact extraction marked as the child's age or the family's home
 *     ({@link RECORD_FIELDS}): the date of birth and the postal code are the record, and
 *     a remembered copy of either is the old one;
 *   - a namespaced key other than a receipt (`recipient:…`, `action_override:…`): an
 *     address a tool reads by key, never a belief to reason from. A receipt
 *     (`health_checkpoint:…`) stays: it is what lets Hale answer "did we book it?" a
 *     week later. The brief leaves receipts off its one-pager when it renders;
 *   - a soft-deleted episode;
 *   - anything about a 13+ child (rule #1). The age gate is deterministic: a row whose
 *     child is 13+ by date of birth TODAY is dropped in SQL, so it never eats the limit
 *     and a fact written when the child was 12 leaves every prompt on their birthday.
 *     A row whose text names a 13+ child is dropped too, whatever child it is filed
 *     under, so content a parent texted about a teen (SMS turns carry no child id)
 *     cannot ride as a family fact or a younger sibling's.
 */

/** The precision bar for a stored belief. Below it, a fact is never written or read. */
export const MEMORY_CONFIDENCE_FLOOR = 0.7;

/** Receipt namespaces the control plane reads back. Never forgotten, never briefed. */
export const RECEIPT_KEY_PREFIXES = ['health_checkpoint:', 'registration_outcome:'] as const;

type FactType = schema.FamilyMemoryFact['factType'];

/** `family_memory_facts.memory_source`, as its CHECK constraint allows it. */
export type FactSource = 'parent_message' | 'calendar' | 'receipt' | 'inferred' | 'legacy';

/**
 * How many days a fact from each source is trusted after it was last seen. A school year
 * for most: `inferred` is the nightly writer of what a parent said or confirmed, and an
 * enduring fact must still reach every prompt six months on (the VIL-598 timeline gate).
 * A calendar-derived fact goes stale with the term. `legacy` is a row from before sources
 * were kept.
 */
export const FACT_FRESH_DAYS: Readonly<Record<FactSource, number>> = {
  inferred: 365,
  calendar: 180,
  receipt: 365,
  parent_message: 365,
  legacy: 365,
};

/** Which source fills the limit first: what the parent said or a receipt showed, then a
 * calendar, then Hale's own guess. Lower wins. */
export const FACT_SOURCE_RANK: Readonly<Record<FactSource, number>> = {
  parent_message: 0,
  receipt: 0,
  calendar: 1,
  legacy: 2,
  inferred: 3,
};

/** The `record` marks extraction stamps on a fact value: age, or where the family lives. */
export const RECORD_FIELDS = ['age', 'place'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FactsForContextOptions {
  now: Date;
  limit: number;
  /** `family`: family-wide facts only. `{ focusedChildId }`: family-wide plus that child's. */
  scope?: 'family' | { focusedChildId: string };
  factTypes?: readonly FactType[];
  excludeKinds?: readonly string[];
}

export interface EpisodesForContextOptions {
  now: Date;
  limit: number;
}

interface RosterChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

export interface TeenRoster {
  ids: string[];
  names: string[];
}

/** The family's 13+ children by date of birth at `now`, the only input the teen gate reads. */
export async function teenRoster(
  database: Database,
  familyId: string,
  now: Date,
): Promise<TeenRoster> {
  const rows: RosterChild[] = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const teens = rows.filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager');
  return { ids: teens.map((row) => row.id), names: teens.map((row) => row.name) };
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` names any of `names` as a whole word, ignoring case and accents. Each
 * part of a name counts on its own ("Ana Sofia" is named by "Sofia"). Over-matching a
 * common word only withholds more, which is the safe direction for rule #1.
 */
export function namesAny(text: string, names: readonly string[]): boolean {
  const haystack = fold(text);
  for (const name of names) {
    for (const part of fold(name).split(/[^\p{L}\p{N}]+/u)) {
      if (part.length < 2) continue;
      const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(part)}($|[^\\p{L}\\p{N}])`, 'u');
      if (word.test(haystack)) return true;
    }
  }
  return false;
}

function factText(fact: { factKey: string; factValue: unknown }): string {
  const value =
    typeof fact.factValue === 'string' ? fact.factValue : JSON.stringify(fact.factValue);
  return `${fact.factKey} ${value ?? ''}`;
}

function freshAt(now: Date): SQL {
  const facts = schema.familyMemoryFacts;
  const cases = (Object.keys(FACT_FRESH_DAYS) as FactSource[]).map((source) => {
    const cutoff = new Date(now.getTime() - FACT_FRESH_DAYS[source] * DAY_MS).toISOString();
    return sql`when ${facts.memorySource} = ${source} then ${facts.sourcedAt} >= ${cutoff}::timestamptz`;
  });
  return sql`(case ${sql.join(cases, sql` `)} else false end)`;
}

function sourceRank(): SQL {
  const facts = schema.familyMemoryFacts;
  const cases = (Object.keys(FACT_SOURCE_RANK) as FactSource[]).map(
    (source) => sql`when ${facts.memorySource} = ${source} then ${FACT_SOURCE_RANK[source]}`,
  );
  return sql`(case ${sql.join(cases, sql` `)} end)`;
}

function notRecordCopy(): SQL {
  const facts = schema.familyMemoryFacts;
  return sql`coalesce(${facts.factValue} ->> 'record', '') not in (${sql.join(
    RECORD_FIELDS.map((field) => sql`${field}`),
    sql`, `,
  )})`;
}

function notTeen(column: AnyPgColumn, teenIds: string[]): SQL | undefined {
  return teenIds.length > 0 ? or(isNull(column), notInArray(column, teenIds)) : undefined;
}

export async function factsForContext(
  database: Database,
  familyId: string,
  options: FactsForContextOptions,
): Promise<schema.FamilyMemoryFact[]> {
  const teens = await teenRoster(database, familyId, options.now);
  const facts = schema.familyMemoryFacts;
  const scope = options.scope;
  const rows = await database
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.familyId, familyId),
        isNull(facts.validUntil),
        gte(facts.confidence, MEMORY_CONFIDENCE_FLOOR),
        or(
          sql`position(':' in ${facts.factKey}) = 0`,
          ...RECEIPT_KEY_PREFIXES.map((prefix) => sql`starts_with(${facts.factKey}, ${prefix})`),
        ),
        or(isNull(facts.expiresAt), gt(facts.expiresAt, options.now)),
        freshAt(options.now),
        notRecordCopy(),
        notTeen(facts.childId, teens.ids),
        scope === 'family' ? isNull(facts.childId) : undefined,
        scope && scope !== 'family'
          ? or(isNull(facts.childId), eq(facts.childId, scope.focusedChildId))
          : undefined,
        options.factTypes ? inArray(facts.factType, [...options.factTypes]) : undefined,
        ...(options.excludeKinds ?? []).map((kind) => ne(facts.memoryKind, kind)),
      ),
    )
    .orderBy(asc(sourceRank()), desc(facts.confidence), desc(facts.validFrom), facts.id)
    .limit(options.limit);
  if (teens.names.length === 0) return rows;
  return rows.filter((row) => !namesAny(factText(row), teens.names));
}

export async function episodesForContext(
  database: Database,
  familyId: string,
  options: EpisodesForContextOptions,
): Promise<schema.FamilyMemoryEpisode[]> {
  const teens = await teenRoster(database, familyId, options.now);
  const episodes = schema.familyMemoryEpisodes;
  const rows = await database
    .select()
    .from(episodes)
    .where(
      and(
        eq(episodes.familyId, familyId),
        isNull(episodes.deletedAt),
        notTeen(episodes.childId, teens.ids),
      ),
    )
    .orderBy(desc(episodes.occurredAt), episodes.id)
    .limit(options.limit);
  if (teens.names.length === 0) return rows;
  return rows.filter((row) => !namesAny(row.summary, teens.names));
}

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
  max,
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
 *     ({@link RECORD_FIELDS}) that is older than that record: a remembered copy of the
 *     date of birth or the postal code is the old one. What the parent said AFTER the
 *     record was last written is their correction, and it rides
 *     ({@link recordCorrections});
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

/** The sources that are the parent's own word: what they texted, or what the nightly
 * inferencer saved from what they said or confirmed. */
const PARENT_WORD_SOURCES: readonly FactSource[] = ['parent_message', 'inferred'];

/** Audit verbs that rewrite where the family lives (settings edit, saved-area switch). */
export const PLACE_RECORD_ACTIONS = ['family_location_updated', 'village_area_activated'] as const;

/** Audit verb that rewrites a child's row, the date of birth included (settings edit). */
export const AGE_RECORD_ACTION = 'child_updated';

/**
 * The parent's newest word on where they live and on each child's age, when they said it
 * AFTER the record was last written (VIL-519). That record is the postal code and the
 * date of birth. A chat correction does not rewrite it yet (VIL-599), so until then the
 * correction is read in its place: the coach's location, the find's town and the find's
 * ages all follow it, and {@link factsForContext} lets it through.
 *
 * "Last written" is the record row's creation or its newest audited edit (rule #6 makes
 * the audit log the history of every edit). A remembered copy from before that is the old
 * one and stays out.
 */
export interface RecordCorrections {
  place: schema.FamilyMemoryFact | null;
  /** By child id. A family-wide age fact counts only when the family has one child. */
  age: ReadonlyMap<string, schema.FamilyMemoryFact>;
}

export async function recordCorrections(
  database: Database,
  familyId: string,
  now: Date,
): Promise<RecordCorrections> {
  const teens = await teenRoster(database, familyId, now);
  return correctionsFor(database, familyId, now, teens);
}

async function correctionsFor(
  database: Database,
  familyId: string,
  now: Date,
  teens: TeenRoster,
): Promise<RecordCorrections> {
  const facts = schema.familyMemoryFacts;
  const marked = await database
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.familyId, familyId),
        isNull(facts.validUntil),
        gte(facts.confidence, MEMORY_CONFIDENCE_FLOOR),
        or(isNull(facts.expiresAt), gt(facts.expiresAt, now)),
        freshAt(now),
        inArray(facts.memorySource, [...PARENT_WORD_SOURCES]),
        sql`${facts.factValue} ->> 'record' in (${sql.join(
          RECORD_FIELDS.map((field) => sql`${field}`),
          sql`, `,
        )})`,
        notTeen(facts.childId, teens.ids),
      ),
    )
    .orderBy(desc(facts.validFrom), facts.id);
  const none: RecordCorrections = { place: null, age: new Map() };
  if (marked.length === 0) return none;

  const audit = schema.auditLog;
  const [family, children, placeEdits, childEdits] = await Promise.all([
    database
      .select({ createdAt: schema.families.createdAt })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1),
    database
      .select({ id: schema.children.id, createdAt: schema.children.createdAt })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    database
      .select({ at: max(audit.occurredAt) })
      .from(audit)
      .where(
        and(eq(audit.familyId, familyId), inArray(audit.actionTaken, [...PLACE_RECORD_ACTIONS])),
      ),
    database
      .select({ childId: audit.targetId, at: max(audit.occurredAt) })
      .from(audit)
      .where(
        and(
          eq(audit.familyId, familyId),
          eq(audit.actionTaken, AGE_RECORD_ACTION),
          eq(audit.targetTable, 'children'),
        ),
      )
      .groupBy(audit.targetId),
  ]);
  const familyCreated = family[0]?.createdAt;
  if (!familyCreated) return none;
  const placeWritten = latest(familyCreated, placeEdits[0]?.at ?? null);
  const childEdit = new Map(childEdits.map((row) => [row.childId, row.at]));
  const childWritten = new Map(
    children.map((child) => [child.id, latest(child.createdAt, childEdit.get(child.id) ?? null)]),
  );
  const onlyChild = children.length === 1 ? children[0]?.id : undefined;

  let place: schema.FamilyMemoryFact | null = null;
  const age = new Map<string, schema.FamilyMemoryFact>();
  for (const row of marked) {
    const record = (row.factValue as { record?: unknown }).record;
    if (record === 'place') {
      if (!place && row.validFrom > placeWritten) place = row;
      continue;
    }
    const childId = row.childId ?? onlyChild;
    const written = childId ? childWritten.get(childId) : undefined;
    if (childId && written && !age.has(childId) && row.validFrom > written) age.set(childId, row);
  }
  return { place, age };
}

const MONTH_MS = (365.25 / 12) * DAY_MS;

/**
 * A corrected age at `now`: the months the parent gave, plus the whole months since they
 * said it. Null when the correction is in words ("she turned five") rather than a number:
 * the fact still rides, and the model reads it in place of the date of birth.
 */
export function correctedAgeMonths(fact: schema.FamilyMemoryFact, now: Date): number | null {
  const months = (fact.factValue as { ageMonths?: unknown } | null)?.ageMonths;
  if (typeof months !== 'number' || !Number.isFinite(months) || months < 0) return null;
  return Math.floor(months + Math.max(0, now.getTime() - fact.validFrom.getTime()) / MONTH_MS);
}

function latest(a: Date, b: Date | null): Date {
  return b && b > a ? b : a;
}

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
  const corrections = await correctionsFor(database, familyId, options.now, teens);
  const correctionIds = [
    ...(corrections.place ? [corrections.place.id] : []),
    ...[...corrections.age.values()].map((row) => row.id),
  ];
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
        correctionIds.length > 0
          ? or(notRecordCopy(), inArray(facts.id, correctionIds))
          : notRecordCopy(),
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

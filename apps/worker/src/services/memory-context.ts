import { type Database, schema } from '@hale/db';
import { deriveStage, namesAny } from '@hale/types';
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
import { type FactSourceLabel, loadFactSources } from './fact-sources.js';

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
 *     cannot ride as a family fact or a younger sibling's;
 *   - (VIL-599, decision R7) a fact another adult said in their own 1:1, or one whose
 *     speaker Hale did not record while another adult is on record. Logistics and
 *     routines, calendar and receipt facts, and what every adult heard reach every
 *     adult. A fact Hale read in a mailbox or calendar reaches only a reader who may be
 *     told where it came from (`loadFactSources`), and rides with that source.
 */

/** The precision bar for a stored belief. Below it, a fact is never written or read. */
export const MEMORY_CONFIDENCE_FLOOR = 0.7;

/** Receipt namespaces the control plane reads back. Never forgotten, never briefed. */
export const RECEIPT_KEY_PREFIXES = ['health_checkpoint:', 'registration_outcome:'] as const;

type FactType = schema.FamilyMemoryFact['factType'];

/** `family_memory_facts.memory_source`, as its CHECK constraint allows it. */
export type MemoryFactSource =
  | 'parent_message'
  | 'calendar'
  | 'receipt'
  | 'inferred'
  | 'legacy';
/** Alias kept for the find slice, which stamps this on each preference. */
export type FactSource = MemoryFactSource;

/**
 * How many days a fact from each source is trusted after it was last seen. A school year
 * for most: `inferred` is the nightly writer of what a parent said or confirmed, and an
 * enduring fact must still reach every prompt six months on (the VIL-598 timeline gate).
 * A calendar-derived fact goes stale with the term. `legacy` is a row from before sources
 * were kept.
 */
export const FACT_FRESH_DAYS: Readonly<Record<MemoryFactSource, number>> = {
  inferred: 365,
  calendar: 180,
  receipt: 365,
  parent_message: 365,
  legacy: 365,
};

/** Which source fills the limit first: what the parent said or a receipt showed, then a
 * calendar, then Hale's own guess. Lower wins. */
export const FACT_SOURCE_RANK: Readonly<Record<MemoryFactSource, number>> = {
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
const PARENT_WORD_SOURCES: readonly MemoryFactSource[] = ['parent_message', 'inferred'];

/** Audit verbs that rewrite where the family lives (settings edit, saved-area switch). */
export const PLACE_RECORD_ACTIONS = ['family_location_updated', 'village_area_activated'] as const;

/** Audit verb that rewrites a child's row, the date of birth included (settings edit). */
export const AGE_RECORD_ACTION = 'child_updated';

/**
 * The parent's newest word on where they live and on each child's age, when they said it
 * AFTER the record was last written (VIL-519). That record is the postal code and the
 * date of birth. A chat correction does not rewrite it yet (VIL-599), so until then the
 * correction is read in its place: the coach's location and the find's town follow a home
 * that is a place name the postal tables hold (off-domain/place.ts), the coach's and the
 * find's ages follow an age, and {@link factsForContext} lets it through. A 13+ child's
 * age is never corrected here, the family-wide only-child credit included.
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
    // The row's own child is teen-filtered in the query; the only-child credit is not.
    if (childId && teens.ids.includes(childId)) continue;
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

/**
 * Who a prompt is read for. Every read names one, so no prompt can carry another adult's
 * 1:1 by leaving it out.
 *  - `{ adult }`: that adult's own thread.
 *  - `every_adult`: somewhere every adult hears (the family group, a household draft).
 *  - `memory_writer`: the nightly memory writer diffing what Hale holds. It is never a
 *    reply, and what it writes back is held to these rules again at every read.
 */
export type FactReader = { adult: string } | 'every_adult' | 'memory_writer';

/** A fact as a prompt receives it: where Hale saw it, when it came from a connector. */
export type ContextFact = schema.FamilyMemoryFact & { seenIn: FactSourceLabel | null };

/** Shared with every adult whoever said them (R7): logistics, and what a calendar or a
 *  receipt recorded. Only for a row in {@link ATTRIBUTED_AUDIENCES}. */
export const SHARED_FACT_TYPES = ['logistic', 'routine'] as const;
export const SHARED_FACT_SOURCES = ['calendar', 'receipt'] as const;
/** The audiences that say where a fact was said; `unrecorded` is the one that does not. */
const ATTRIBUTED_AUDIENCES = ['one_to_one', 'family'] as const;
/** The scope of every `unrecorded` row in a live fact's identity ({@link liveScopeSql}). */
export const UNRECORDED_SCOPE = 'unrecorded';

/**
 * Whether any adult other than `readerUserId` was ever part of the family: a current
 * seat, anyone who texted in it (departure keeps their messages), or any user named as an
 * actor on its immutable audit trail (departure writes one). Null asks whether the family
 * has had more than one adult. History, not today's seats: a co-parent who left still
 * counts, so their past words never pass to the parent who stayed.
 */
export async function anotherAdultOnRecord(
  database: Database,
  familyId: string,
  readerUserId: string | null,
): Promise<boolean> {
  const result = (await database.execute(sql`
    select distinct adults.user_id from (
      select ${schema.familyMembers.userId} as user_id from ${schema.familyMembers}
        where ${schema.familyMembers.familyId} = ${familyId}
      union
      select ${schema.channelMessages.parentUserId} from ${schema.channelMessages}
        where ${schema.channelMessages.familyId} = ${familyId}
      union
      select ${schema.users.id} from ${schema.auditLog}
        join ${schema.users} on ${schema.users.id}::text = ${schema.auditLog.actor}
        where ${schema.auditLog.familyId} = ${familyId}
    ) adults
    where adults.user_id is not null
    limit 2
  `)) as unknown as { rows?: { user_id: string }[] } | { user_id: string }[];
  const ids = (Array.isArray(result) ? result : (result.rows ?? [])).map((row) => row.user_id);
  return readerUserId === null ? ids.length > 1 : ids.some((id) => id !== readerUserId);
}

type HeardRow = Pick<
  schema.FamilyMemoryFact,
  'factType' | 'memorySource' | 'sourceAudience' | 'sourceUserId'
>;

/**
 * Whether `readerUserId` may hear a fact while another adult is on record (R7), and if
 * not, why. Null reads for every adult at once. {@link heardBySql} is the same rule as a
 * query predicate.
 *
 * The R7 exemption by type or source holds only for a row that says where it was said.
 * An `unrecorded` row is never shared by it: the nightly writer reads every adult's
 * facts, so a routine it derived from one adult's private fact would otherwise reach the
 * other adult by its type.
 */
export function factHeardBy(
  row: HeardRow,
  readerUserId: string | null,
): 'heard' | 'another_adult' | 'unrecorded' {
  if (row.sourceAudience === 'unrecorded') return 'unrecorded';
  if ((SHARED_FACT_TYPES as readonly string[]).includes(row.factType)) return 'heard';
  if ((SHARED_FACT_SOURCES as readonly string[]).includes(row.memorySource)) return 'heard';
  if (row.sourceAudience === 'family') return 'heard';
  return readerUserId !== null && row.sourceUserId === readerUserId ? 'heard' : 'another_adult';
}

function heardBySql(readerUserId: string | null): SQL | undefined {
  const facts = schema.familyMemoryFacts;
  return or(
    and(
      inArray(facts.sourceAudience, [...ATTRIBUTED_AUDIENCES]),
      or(
        inArray(facts.factType, [...SHARED_FACT_TYPES]),
        inArray(facts.memorySource, [...SHARED_FACT_SOURCES]),
      ),
    ),
    eq(facts.sourceAudience, 'family'),
    readerUserId === null
      ? undefined
      : and(eq(facts.sourceAudience, 'one_to_one'), eq(facts.sourceUserId, readerUserId)),
  );
}

type ScopedRow = Pick<schema.FamilyMemoryFact, 'factType' | 'memorySource' | 'sourceAudience'>;

/**
 * A fact only its speaker may hear: said in their own 1:1 and not shared by R7. The
 * same rule as `factHeardBy`'s `one_to_one` branch, and as {@link liveScopeSql}.
 */
export function isPrivateFact(row: ScopedRow): boolean {
  return (
    row.sourceAudience === 'one_to_one' &&
    !(SHARED_FACT_TYPES as readonly string[]).includes(row.factType) &&
    !(SHARED_FACT_SOURCES as readonly string[]).includes(row.memorySource)
  );
}

/**
 * Whose a row is: the fifth part of a live fact's identity
 * (`memory_facts_one_live_per_scope_idx`, migration 0218), as text.
 *  - A private fact is scoped to its speaker, so A's and B's private facts on one key are
 *    both live and no write by one adult closes the other's. A private row whose speaker
 *    was deleted (`source_user_id` is `ON DELETE SET NULL`) is scoped to its own id:
 *    nobody's, and never in a shared row's way, so deleting a user can never fail on
 *    this index.
 *  - An `unrecorded` row (the nightly writer, and rows saved before 0218) is scoped to
 *    {@link UNRECORDED_SCOPE}, so the nightly writer only ever supersedes its own rows and
 *    never a household fact that two adults could both still hear.
 *  - Every other fact is the household's (null), one live row per key.
 * The migration spells the same expression; change both or neither.
 */
export function liveScopeSql(): SQL {
  const facts = schema.familyMemoryFacts;
  const isPrivate = and(
    eq(facts.sourceAudience, 'one_to_one'),
    notInArray(facts.factType, [...SHARED_FACT_TYPES]),
    notInArray(facts.memorySource, [...SHARED_FACT_SOURCES]),
  );
  return sql`(case when ${isPrivate} then coalesce(${facts.sourceUserId}, ${facts.id})::text when ${facts.sourceAudience} = ${UNRECORDED_SCOPE} then ${UNRECORDED_SCOPE} end)`;
}

type IdentityRow = Pick<
  schema.FamilyMemoryFact,
  'id' | 'childId' | 'factType' | 'factKey' | 'validFrom' | 'createdAt'
>;

function newerFact(a: IdentityRow, b: IdentityRow): boolean {
  const byValidFrom = a.validFrom.getTime() - b.validFrom.getTime();
  if (byValidFrom !== 0) return byValidFrom > 0;
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt > 0;
  return a.id > b.id;
}

/**
 * One fact per (child, type, key) for one reader. In an adult's own 1:1 their private
 * row and the household's row may both be live on one key (the identity above); the
 * reader gets the newer, so a correction A made in A's 1:1 is what A hears back. A read
 * for every adult only ever sees household rows, one per key, so this changes nothing
 * there. Order is kept.
 */
export function newestPerIdentity<T extends IdentityRow>(rows: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.childId ?? ''}|${row.factType}|${row.factKey}`;
    const held = newest.get(key);
    if (!held || newerFact(row, held)) newest.set(key, row);
  }
  const kept = new Set(newest.values());
  return rows.filter((row) => kept.has(row));
}

/** The predicate a fact read adds for `reader`, or none when nothing is another adult's. */
export async function audiencePredicate(
  database: Database,
  familyId: string,
  reader: FactReader,
): Promise<SQL | undefined> {
  if (reader === 'memory_writer') return undefined;
  const readerUserId = reader === 'every_adult' ? null : reader.adult;
  if (!(await anotherAdultOnRecord(database, familyId, readerUserId))) return undefined;
  return heardBySql(readerUserId);
}

export interface FactsForContextOptions {
  now: Date;
  reader: FactReader;
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

export { namesAny };

/** Every string value and object key in `value`, at any depth. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => [key, ...stringLeaves(v)]);
  }
  return [];
}

/**
 * Whether any string in `value` (a value, an object key, at any depth) names
 * one of `names`. The one teen-name check: it never reads JSON text, where a
 * newline is written `\n` and the escape's letter touches the name and hides
 * it from the whole-word match (VIL-618). For memory facts, object keys are
 * scanned too, so a fact filed under a child's name is still a hit (VIL-634).
 */
export function namesAnyIn(value: unknown, names: readonly string[]): boolean {
  return names.length > 0 && stringLeaves(value).some((text) => namesAny(text, names));
}

function freshAt(now: Date): SQL {
  const facts = schema.familyMemoryFacts;
  const cases = (Object.keys(FACT_FRESH_DAYS) as MemoryFactSource[]).map((source) => {
    const cutoff = new Date(now.getTime() - FACT_FRESH_DAYS[source] * DAY_MS).toISOString();
    return sql`when ${facts.memorySource} = ${source} then ${facts.sourcedAt} >= ${cutoff}::timestamptz`;
  });
  return sql`(case ${sql.join(cases, sql` `)} else false end)`;
}

function sourceRank(): SQL {
  const facts = schema.familyMemoryFacts;
  const cases = (Object.keys(FACT_SOURCE_RANK) as MemoryFactSource[]).map(
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
): Promise<ContextFact[]> {
  const teens = await teenRoster(database, familyId, options.now);
  const [audience, corrections] = await Promise.all([
    audiencePredicate(database, familyId, options.reader),
    correctionsFor(database, familyId, options.now, teens),
  ]);
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
        audience,
      ),
    )
    .orderBy(asc(sourceRank()), desc(facts.confidence), desc(facts.validFrom), facts.id)
    .limit(options.limit);
  const named =
    teens.names.length === 0
      ? rows
      : rows.filter((row) => !namesAnyIn([row.factKey, row.factValue], teens.names));
  if (options.reader === 'memory_writer') return named.map((row) => ({ ...row, seenIn: null }));
  // Deduplicated after the limit: two live rows on one key are an adult's own correction
  // over a household fact, rare enough that the slot it costs is not worth a window query.
  const current = newestPerIdentity(named);
  const sources = await loadFactSources(database, {
    familyId,
    readerUserId: options.reader === 'every_adult' ? null : options.reader.adult,
    inGroup: options.reader === 'every_adult',
    now: options.now,
    sourceEventIds: current.map((row) => row.sourceEventId),
  });
  // A connector fact this reader may not be told the source of is left out, so no reply
  // can use it without saying where it came from (VIL-429).
  return current.flatMap((row): ContextFact[] => {
    const source = row.sourceEventId ? sources.get(row.sourceEventId) : undefined;
    if (!source?.connector) return [{ ...row, seenIn: null }];
    return source.label ? [{ ...row, seenIn: source.label }] : [];
  });
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
  return rows.filter((row) => !namesAnyIn(row.summary, teens.names));
}

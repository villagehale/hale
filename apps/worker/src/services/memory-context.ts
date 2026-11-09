import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import {
  type SQL,
  and,
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
 *  receipt recorded. */
export const SHARED_FACT_TYPES = ['logistic', 'routine'] as const;
export const SHARED_FACT_SOURCES = ['calendar', 'receipt'] as const;

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
 * query predicate; the two are tested against each other.
 */
export function factHeardBy(
  row: HeardRow,
  readerUserId: string | null,
): 'heard' | 'another_adult' | 'unrecorded' {
  if ((SHARED_FACT_TYPES as readonly string[]).includes(row.factType)) return 'heard';
  if ((SHARED_FACT_SOURCES as readonly string[]).includes(row.memorySource)) return 'heard';
  if (row.sourceAudience === 'family') return 'heard';
  if (row.sourceAudience === 'one_to_one') {
    return readerUserId !== null && row.sourceUserId === readerUserId ? 'heard' : 'another_adult';
  }
  return 'unrecorded';
}

function heardBySql(readerUserId: string | null): SQL | undefined {
  const facts = schema.familyMemoryFacts;
  return or(
    inArray(facts.factType, [...SHARED_FACT_TYPES]),
    inArray(facts.memorySource, [...SHARED_FACT_SOURCES]),
    eq(facts.sourceAudience, 'family'),
    readerUserId === null
      ? undefined
      : and(eq(facts.sourceAudience, 'one_to_one'), eq(facts.sourceUserId, readerUserId)),
  );
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
function namesAny(text: string, names: readonly string[]): boolean {
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
 * Whether any string in `value` (a value, an object key, at any depth) names one of
 * `names`. The one teen-name check: it never reads JSON text, where a newline is
 * written `\n` and the escape's letter touches the name and hides it from the
 * whole-word match (VIL-618).
 */
export function namesAnyIn(value: unknown, names: readonly string[]): boolean {
  return names.length > 0 && stringLeaves(value).some((text) => namesAny(text, names));
}

function notTeen(column: AnyPgColumn, teenIds: string[]): SQL | undefined {
  return teenIds.length > 0 ? or(isNull(column), notInArray(column, teenIds)) : undefined;
}

export async function factsForContext(
  database: Database,
  familyId: string,
  options: FactsForContextOptions,
): Promise<ContextFact[]> {
  const [teens, audience] = await Promise.all([
    teenRoster(database, familyId, options.now),
    audiencePredicate(database, familyId, options.reader),
  ]);
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
    .orderBy(desc(facts.confidence), desc(facts.validFrom), facts.id)
    .limit(options.limit);
  const named =
    teens.names.length === 0
      ? rows
      : rows.filter((row) => !namesAnyIn([row.factKey, row.factValue], teens.names));
  if (options.reader === 'memory_writer') return named.map((row) => ({ ...row, seenIn: null }));
  const sources = await loadFactSources(database, {
    familyId,
    readerUserId: options.reader === 'every_adult' ? null : options.reader.adult,
    inGroup: options.reader === 'every_adult',
    now: options.now,
    sourceEventIds: named.map((row) => row.sourceEventId),
  });
  // A connector fact this reader may not be told the source of is left out, so no reply
  // can use it without saying where it came from (VIL-429).
  return named.flatMap((row): ContextFact[] => {
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

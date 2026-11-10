import { type Database, schema } from '@hale/db';
import { UNRECORDED_SCOPE, isPrivateFact, liveScopeSql } from '@hale/worker/memory-context';
import { type SQL, and, eq, inArray, isNull, sql } from 'drizzle-orm';

/**
 * The one way a family memory fact is written.
 *
 * `family_memory_facts` is bi-temporal with provenance — `valid_from`,
 * `valid_until`, `superseded_by`, `confidence` — and five writers each spelled the
 * supersede protocol themselves. They disagreed: none set `superseded_by`, none set
 * `valid_from`, the per-child writers closed rows belonging to OTHER children, and
 * two wrote no supersede at all and simply accumulated live duplicates. That is one
 * missing primitive, not five bugs, so the protocol lives here and the writers state
 * only what they know.
 *
 * The identity of a fact is `(family, child, type, key, scope)`, where the scope names
 * the speaker of a private fact, is `unrecorded` for a fact no adult is recorded saying,
 * and is null for the household's (`liveScopeSql`, VIL-599). Postgres enforces one live row per identity
 * (`memory_facts_one_live_per_scope_idx`, migration 0218), which is
 * what makes this the only correct way in rather than the polite one: a writer that
 * skips the supersede now fails loudly instead of quietly leaving Hale holding two
 * contradictory truths.
 *
 * `writeFact` and `closeFacts` below are the COMPLETE set of writers to `valid_until`:
 * grep the repo and every other mention of the column is an `IS NULL` read filter.
 * Keeping it that way is what lets every reader say "live" by one predicate.
 */

/** A fact below this confidence is a hunch. Hunches are refused, never written. */
export { MEMORY_CONFIDENCE_FLOOR as CONFIDENCE_FLOOR } from '@hale/worker/memory-context';

type MemoryFactType = schema.NewFamilyMemoryFact['factType'];

/** The query surface a write needs — satisfied by both `Database` and a transaction. */
export type FactWriter = Pick<Database, 'insert' | 'update'>;

/**
 * VIL-599 · who said a fact, and so which adult may hear it back (decision R7: co-parents
 * share logistics; anything else said in one adult's 1:1 stays with that adult). Every
 * writer states it; the read (`factsForContext`) enforces it.
 *  - `one_to_one`: said in `userId`'s own thread.
 *  - `family`: said where every adult of the family heard it (the family group, a
 *    household record). `userId` names the speaker when one adult said it.
 *  - `unrecorded`: the writer cannot say which adult it came from. Held back from every
 *    adult while another adult is on record, like a row saved before this was kept.
 */
export type FactHeard =
  | { in: 'one_to_one'; userId: string }
  | { in: 'family'; userId: string | null }
  | 'unrecorded';

/** Hale's own household bookkeeping (what it asked, a count it keeps): no adult said it. */
export const HALE_RECORD: FactHeard = { in: 'family', userId: null };

export interface FactWrite {
  familyId: string;
  /** Null = family-wide. Part of the identity: siblings hold their own truths. */
  childId: string | null;
  factType: MemoryFactType;
  factKey: string;
  factValue: unknown;
  confidence: number;
  /** Which writer produced this, verbatim into `inferred_by`. */
  inferredBy: string;
  /** The event this was derived from, when one is known. */
  sourceEventId?: string;
  heard: FactHeard;
  /**
   * When the fact BECAME true — the source event's time, not the moment Hale
   * learned it. "Mia started daycare in September", read in November, is valid
   * from September; collapsing the two axes is what makes a memory read lie about
   * its own history.
   */
  validFrom: Date;
  /**
   * VIL-391. Omit every field below and the row is the backfill shape
   * (`lasting` / `legacy`), which is what a write does while the kinds flag
   * is off. Passing them is the flag-on path.
   */
  memoryKind?: 'lasting' | 'temporary' | 'one_off';
  memorySource?: 'parent_message' | 'calendar' | 'receipt' | 'inferred' | 'legacy';
  sourcedAt?: Date;
  expiresAt?: Date | null;
  signalCount?: number;
}

/**
 * The scope a write lands in (`liveScopeSql`): the speaker when the fact is private to
 * them, the nightly writer's own when it is `unrecorded`, else the household's (null). A
 * write supersedes only within its own scope, so A's 1:1 never closes B's private fact or
 * the household's, and the nightly writer never closes anyone's fact but its own.
 */
export function sameScope(write: {
  factType: MemoryFactType;
  memorySource?: FactWrite['memorySource'];
  heard: FactHeard;
}): SQL {
  if (write.heard === 'unrecorded') return sql`${liveScopeSql()} = ${UNRECORDED_SCOPE}`;
  const speaker =
    write.heard.in === 'one_to_one' &&
    isPrivateFact({
      factType: write.factType,
      memorySource: write.memorySource ?? 'legacy',
      sourceAudience: write.heard.in,
    })
      ? write.heard.userId
      : null;
  return speaker === null ? sql`${liveScopeSql()} is null` : sql`${liveScopeSql()} = ${speaker}`;
}

export interface FactWriteResult {
  factId: string;
  /** The live facts this write closed. Empty when nothing was replaced. */
  supersededFactIds: string[];
}

/**
 * Supersedes whatever was live on this identity and writes the new fact, leaving a
 * followable chain: the closed row's `valid_until` is when the new one began and its
 * `superseded_by` names the row that replaced it.
 *
 * Ordering is load-bearing. The old row is closed BEFORE the insert, because the
 * unique index permits exactly one live row per identity and a write that inserted
 * first would collide with the row it is about to retire. The back-pointer is then
 * stamped in a third statement — it cannot be written earlier, since the id it
 * points at does not exist until the insert returns. Call inside a transaction when
 * the write shares one with an audit row (rule #6).
 */
export async function writeFact(writer: FactWriter, write: FactWrite): Promise<FactWriteResult> {
  const superseded = await writer
    .update(schema.familyMemoryFacts)
    .set({
      // An out-of-order write (a source event older than the fact it replaces)
      // must not close an interval before it opened.
      validUntil: sql`greatest(${schema.familyMemoryFacts.validFrom}, ${write.validFrom})`,
    })
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, write.familyId),
        write.childId === null
          ? isNull(schema.familyMemoryFacts.childId)
          : eq(schema.familyMemoryFacts.childId, write.childId),
        eq(schema.familyMemoryFacts.factType, write.factType),
        eq(schema.familyMemoryFacts.factKey, write.factKey),
        isNull(schema.familyMemoryFacts.validUntil),
        sameScope(write),
      ),
    )
    .returning({ id: schema.familyMemoryFacts.id });

  const inserted = await writer
    .insert(schema.familyMemoryFacts)
    .values({
      familyId: write.familyId,
      childId: write.childId,
      factType: write.factType,
      factKey: write.factKey,
      factValue: write.factValue,
      confidence: write.confidence,
      inferredBy: write.inferredBy,
      sourceEventId: write.sourceEventId,
      sourceAudience: write.heard === 'unrecorded' ? 'unrecorded' : write.heard.in,
      sourceUserId: write.heard === 'unrecorded' ? null : write.heard.userId,
      validFrom: write.validFrom,
      ...(write.memoryKind ? { memoryKind: write.memoryKind } : {}),
      ...(write.memorySource ? { memorySource: write.memorySource } : {}),
      ...(write.sourcedAt ? { sourcedAt: write.sourcedAt } : {}),
      ...(write.expiresAt !== undefined ? { expiresAt: write.expiresAt } : {}),
      ...(write.signalCount !== undefined ? { signalCount: write.signalCount } : {}),
    })
    .returning({ id: schema.familyMemoryFacts.id });

  const factId = inserted[0]?.id;
  if (!factId) {
    throw new Error('writeFact: family_memory_facts insert returned no row');
  }

  const supersededFactIds = superseded.map((row) => row.id);
  if (supersededFactIds.length > 0) {
    await writer
      .update(schema.familyMemoryFacts)
      .set({ supersededBy: factId })
      .where(inArray(schema.familyMemoryFacts.id, supersededFactIds));
  }

  return { factId, supersededFactIds };
}

/** What a close actually did. The ids asked for but NOT closed are the caller's
 *  outcome to name — a race or a second run in the same night, never a silent
 *  success (rule #11). */
export interface CloseResult {
  closedFactIds: string[];
  alreadyClosedFactIds: string[];
}

export interface FactClose {
  factIds: string[];
  closedAt: Date;
  /** The row that replaces these, or null when nothing does — a retirement rather
   *  than a merge. Written verbatim, so a merge leaves a followable chain. */
  supersededBy: string | null;
}

/**
 * Ends the live interval of facts named BY ID — the second and last way `valid_until`
 * is ever written. `writeFact` closes by IDENTITY (family, child, type, key) because a
 * new value is arriving; this closes rows a caller has already elected, with nothing
 * arriving to take their place.
 *
 * They are not folded together. The supersede/insert/back-stamp ordering above exists
 * because an insert is coming, and a by-id close has no insert to order against;
 * sharing one statement would mean an argument that switches the WHERE clause, which
 * is two functions wearing one name.
 *
 * `valid_until IS NULL` in the WHERE is what makes the pass idempotent without a
 * marker column: a retired row stays retired, at the instant it was first retired, so
 * running twice in one night cannot walk a retirement date forward. The `greatest()`
 * clamp is the same one `writeFact` uses — an out-of-order close must not end an
 * interval before it opened. Call inside a transaction when the close shares one with
 * an audit row (rule #6).
 */
export async function closeFacts(writer: FactWriter, close: FactClose): Promise<CloseResult> {
  if (close.factIds.length === 0) return { closedFactIds: [], alreadyClosedFactIds: [] };

  const closed = await writer
    .update(schema.familyMemoryFacts)
    .set({
      validUntil: sql`greatest(${schema.familyMemoryFacts.validFrom}, ${close.closedAt})`,
      supersededBy: close.supersededBy,
    })
    .where(
      and(
        inArray(schema.familyMemoryFacts.id, close.factIds),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .returning({ id: schema.familyMemoryFacts.id });

  const closedFactIds = closed.map((row) => row.id);
  const closedSet = new Set(closedFactIds);
  return {
    closedFactIds,
    alreadyClosedFactIds: close.factIds.filter((id) => !closedSet.has(id)),
  };
}

/**
 * The event time a model claims a fact became true, accepted only when it is a real
 * instant at or before the run clock. A model that offers nothing, a malformed
 * string, or a date in the future gets the run clock — inventing a provenance
 * timestamp is worse than admitting we only know when we read it.
 */
export function resolveValidFrom(observedAt: string | undefined, now: Date): Date {
  if (!observedAt) return now;
  const parsed = new Date(observedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime()) return now;
  return parsed;
}

import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

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
 * The identity of a fact is `(family, child, type, key)`. Postgres enforces one live
 * row per identity (`memory_facts_one_live_per_key_idx`, migration 0081), which is
 * what makes this the only correct way in rather than the polite one: a writer that
 * skips the supersede now fails loudly instead of quietly leaving Hale holding two
 * contradictory truths.
 *
 * `writeFact` and `closeFacts` below are the COMPLETE set of writers to `valid_until`:
 * grep the repo and every other mention of the column is an `IS NULL` read filter.
 * Keeping it that way is what lets every reader say "live" by one predicate.
 */

/** A fact below this confidence is a hunch. Hunches are refused, never written. */
export const CONFIDENCE_FLOOR = 0.7;

type MemoryFactType = schema.NewFamilyMemoryFact['factType'];

/** The query surface a write needs — satisfied by both `Database` and a transaction. */
export type FactWriter = Pick<Database, 'insert' | 'update'>;

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
  /**
   * When the fact BECAME true — the source event's time, not the moment Hale
   * learned it. "Mia started daycare in September", read in November, is valid
   * from September; collapsing the two axes is what makes a memory read lie about
   * its own history.
   */
  validFrom: Date;
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
      validFrom: write.validFrom,
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

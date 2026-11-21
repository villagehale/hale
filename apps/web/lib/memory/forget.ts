import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { closeFacts } from './facts';
import { type MemoryKindEnv, familyMemoryKindsEnabled } from './kinds';
import { isReceiptKey } from './lexicon';
import { SYNTHESIS_WRITERS } from './synthesis';

/**
 * A parent asked Hale to forget one fact.
 *
 * The row is retired (`valid_until` set, `superseded_by` null), so default
 * search and the one-pager drop it, and `memory_history` can still walk it.
 * Control-plane receipts are refused even when a model names their id: closing
 * one would let a completed health or registration prompt come back.
 *
 * Belief writers only. A row with no writer, or a writer outside the synthesis
 * allowlist, is not Hale's to quietly drop.
 */

const BELIEF_WRITERS = new Set<string>(SYNTHESIS_WRITERS);

/** The audit verb a parent's forget writes; also how a later writer knows it was one. */
export const MEMORY_FACT_FORGOTTEN = 'memory_fact_forgotten';

export interface ForgetFactResult {
  forgotten: number;
  refusedControlPlane: number;
  refusedWriter: number;
  alreadyClosed: number;
  notFound: number;
}

export async function forgetFamilyFact(
  database: Database,
  input: { familyId: string; factId: string; actor: string; now: Date },
): Promise<ForgetFactResult> {
  const result: ForgetFactResult = {
    forgotten: 0,
    refusedControlPlane: 0,
    refusedWriter: 0,
    alreadyClosed: 0,
    notFound: 0,
  };

  const [row] = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.id, input.factId),
        eq(schema.familyMemoryFacts.familyId, input.familyId),
      ),
    )
    .limit(1);

  if (!row) {
    result.notFound = 1;
    return result;
  }
  if (row.validUntil !== null) {
    result.alreadyClosed = 1;
    return result;
  }
  if (
    isReceiptKey(row.factKey) ||
    (row.inferredBy !== null && !BELIEF_WRITERS.has(row.inferredBy))
  ) {
    if (
      isReceiptKey(row.factKey) ||
      row.inferredBy === 'health-nudge-reply' ||
      row.inferredBy === 'registration-sequence-reply'
    ) {
      result.refusedControlPlane = 1;
    } else {
      result.refusedWriter = 1;
    }
    return result;
  }
  if (row.inferredBy === null || !BELIEF_WRITERS.has(row.inferredBy)) {
    result.refusedWriter = 1;
    return result;
  }

  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.actor,
      // A literal, not the constant: the trail's verb drift test reads write sites statically.
      actionTaken: 'memory_fact_forgotten',
      targetTable: 'family_memory_facts',
      targetId: row.id,
      after: { factId: row.id, applied: true },
    });
    const closed = await closeFacts(tx, {
      factIds: [row.id],
      closedAt: input.now,
      supersededBy: null,
    });
    result.forgotten = closed.closedFactIds.length;
    result.alreadyClosed = closed.alreadyClosedFactIds.length;
  });

  return result;
}

/**
 * How long a parent's forget keeps the nightly writers from saving the same fact again.
 * Longer than the windows they re-read (7 days of events, 14 of conversation), so the
 * words that taught the fact have aged out before it may be learned again; a fact the
 * parent says afresh after that is theirs to have remembered.
 */
export const FORGOTTEN_HOLD_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Did a parent ask Hale to forget this fact recently? Read by the nightly writers before a
 * save, so "forget X" is not undone overnight by re-reading the message that taught X.
 * Matched on the family, the child and the key; only a row a parent forgot (its own audit
 * verb, nothing superseding it), never one a writer replaced. Flag off: false, no read.
 */
export async function parentForgotRecently(
  database: Database,
  input: {
    familyId: string;
    childId: string | null;
    factKey: string;
    now: Date;
    env?: MemoryKindEnv;
  },
): Promise<boolean> {
  if (!familyMemoryKindsEnabled(input.env ?? process.env)) return false;
  const since = new Date(input.now.getTime() - FORGOTTEN_HOLD_MS);
  const closed = await database
    .select({ id: schema.familyMemoryFacts.id })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        input.childId === null
          ? isNull(schema.familyMemoryFacts.childId)
          : eq(schema.familyMemoryFacts.childId, input.childId),
        eq(schema.familyMemoryFacts.factKey, input.factKey),
        isNull(schema.familyMemoryFacts.supersededBy),
        gte(schema.familyMemoryFacts.validUntil, since),
      ),
    )
    .limit(20);
  if (closed.length === 0) return false;
  const [forgot] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, input.familyId),
        eq(schema.auditLog.actionTaken, MEMORY_FACT_FORGOTTEN),
        eq(schema.auditLog.targetTable, 'family_memory_facts'),
        inArray(
          schema.auditLog.targetId,
          closed.map((row) => row.id),
        ),
      ),
    )
    .limit(1);
  return forgot !== undefined;
}

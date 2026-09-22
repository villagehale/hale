import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { closeFacts } from './facts';
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

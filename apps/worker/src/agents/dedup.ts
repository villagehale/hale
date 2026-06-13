import { createHash } from 'node:crypto';

/**
 * Stable content hash for an inbound signal — the (family_id, dedup_hash) unique
 * key on events. Pure and LLM-free, so the orchestrator can probe for an
 * already-processed event BEFORE paying for a classifier call: a crash-and-retry
 * after classify must not re-bill the classifier (B10 re-entrancy).
 */
export function dedupHashFor(familyId: string, source: string, rawContent: string): string {
  return createHash('sha256').update(`${familyId}|${source}|${rawContent}`).digest('hex');
}

import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { proactiveCadence } from './flag';

/**
 * VIL-226 · one queue per family. Senders write a candidate here instead of
 * texting, except a reply or a requested time-critical item, which still send
 * through the red lines.
 *
 * `off` does not write a row. `shadow` writes and the caller still sends.
 * `live` writes and the caller does not send.
 */

export type CadenceLane = 'reply' | 'immediate' | 'candidate';

export interface CandidateDraft {
  familyId: string;
  kind: string;
  what: string;
  why: string;
  sourceUrl: string | null;
  worthlessAfter: Date | null;
  parentRequested: boolean;
  dedupeKey: string;
}

export type RouteResult = 'send' | 'queued';

export function candidateDedupeKey(familyId: string, parts: string): string {
  return createHash('sha256').update(`${familyId}\n${parts}`).digest('hex').slice(0, 32);
}

/**
 * Whether this send should leave now. Replies and requested time-critical
 * items always send. Everything else queues when the flag is live.
 */
export function routeLane(lane: CadenceLane): RouteResult {
  const mode = proactiveCadence();
  if (mode !== 'live') return 'send';
  if (lane === 'reply' || lane === 'immediate') return 'send';
  return 'queued';
}

export async function enqueueCandidate(
  database: Database,
  draft: CandidateDraft,
): Promise<
  | { status: 'queued'; id: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: 'cadence_off' | 'no_database' }
> {
  if (proactiveCadence() === 'off') return { status: 'skipped', reason: 'cadence_off' };
  if (typeof database.insert !== 'function' || typeof database.select !== 'function') {
    console.error(
      { familyId: draft.familyId, kind: draft.kind },
      'proactive cadence: queue has no database — candidate not stored',
    );
    return { status: 'skipped', reason: 'no_database' };
  }
  const [existing] = await database
    .select({ id: schema.proactiveCandidates.id })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, draft.familyId),
        eq(schema.proactiveCandidates.dedupeKey, draft.dedupeKey),
        inArray(schema.proactiveCandidates.status, ['queued', 'held']),
      ),
    )
    .limit(1);
  if (existing) return { status: 'duplicate' };
  let row: { id: string } | undefined;
  try {
    const inserted = await database
      .insert(schema.proactiveCandidates)
      .values({
        familyId: draft.familyId,
        kind: draft.kind,
        what: draft.what.slice(0, 500),
        why: draft.why.slice(0, 500),
        sourceUrl: draft.sourceUrl,
        worthlessAfter: draft.worthlessAfter,
        parentRequested: draft.parentRequested,
        dedupeKey: draft.dedupeKey,
        status: 'queued',
      })
      .returning({ id: schema.proactiveCandidates.id });
    row = inserted[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('proactive_candidates_open_dedupe')) return { status: 'duplicate' };
    throw err;
  }
  if (!row) {
    console.error({ familyId: draft.familyId }, 'proactive cadence: insert returned no row');
    return { status: 'skipped', reason: 'no_database' };
  }
  return { status: 'queued', id: row.id };
}

/**
 * Queue when the flag says so. Shadow still returns `send` after the insert.
 * Live returns `queued` and the caller must not send. A store failure on live
 * is `queued` as well — better a missed text than a text the decider did not see.
 */
export async function routeProactiveDelivery(
  database: Database,
  draft: CandidateDraft,
  lane: CadenceLane,
): Promise<RouteResult> {
  const mode = proactiveCadence();
  if (mode === 'off' || lane !== 'candidate') return 'send';
  const stored = await enqueueCandidate(database, draft);
  if (stored.status === 'skipped') {
    console.error(
      { familyId: draft.familyId, reason: stored.reason, lane },
      'proactive cadence: candidate was not stored',
    );
    return mode === 'live' ? 'queued' : 'send';
  }
  if (mode === 'shadow') {
    console.info(
      { familyId: draft.familyId, kind: draft.kind, stored: stored.status },
      'proactive cadence: shadow queued; the old path still sends',
    );
    return 'send';
  }
  return 'queued';
}

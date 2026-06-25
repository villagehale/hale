import { and, eq, sql } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { type IngestedEventPayload, ingestedEventPayloadSchema } from '@hale/tools-contracts';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';

/**
 * Minimal queue surface the accept flow needs — just `send`. Injected so the
 * precondition + payload-build logic is unit-testable without a real pg-boss.
 * Mirrors ApproveQueue: the accept route hands the candidate off into the SAME
 * events.ingested pipeline (classify → draft → review → drafted_for_approval),
 * it never executes directly.
 */
/** The `events.source` value the accept flow tags every ingested village item
 * with — the join key the accepted-state query filters on so it never picks up a
 * non-village event that happens to carry a candidate_id. */
const VILLAGE_SOURCE = 'village';

export interface AcceptQueue {
  send(
    name: string,
    data: IngestedEventPayload,
    options?: { expireInSeconds: number },
  ): Promise<string | null>;
}

export type AcceptResult =
  | { status: 202; payload: IngestedEventPayload }
  | { status: 403; error: string }
  | { status: 404; error: string };

/**
 * Validates that `candidateId` exists and belongs to `familyId`, then enqueues
 * an events.ingested job carrying the discovered activity so the EXISTING
 * pipeline drafts → reviews → routes it to drafted_for_approval; the parent then
 * finishes it via /api/actions/:id/approve. Accepting NEVER executes directly —
 * it only re-enters the spine, keeping every downstream gate (reviewer tool
 * coverage, spending caps, teen-redaction cap) intact.
 *
 * Order matters: cross-family is a 403 (it exists but isn't yours) and a missing
 * candidate is 404. No event is sent unless the candidate is the caller's.
 *
 * Rule #1: only the candidate's already-coarse stored fields flow into the
 * payload (title/kind/summary + coarse coverage note + source url). No precise
 * location is ever persisted on the row, so none can leak here.
 */
export async function acceptVillageCandidate(
  database: Database,
  queue: AcceptQueue,
  args: { candidateId: string; familyId: string },
): Promise<AcceptResult> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      familyId: schema.villageCandidates.familyId,
      title: schema.villageCandidates.title,
      kind: schema.villageCandidates.kind,
      summary: schema.villageCandidates.summary,
      sourceUrl: schema.villageCandidates.sourceUrl,
      coverageNote: schema.villageCandidates.coverageNote,
    })
    .from(schema.villageCandidates)
    .where(eq(schema.villageCandidates.id, args.candidateId))
    .limit(1);

  const candidate = rows[0];
  if (!candidate) {
    return { status: 404, error: 'candidate_not_found' };
  }
  if (candidate.familyId !== args.familyId) {
    return { status: 403, error: 'candidate_belongs_to_another_family' };
  }

  const payload: IngestedEventPayload = ingestedEventPayloadSchema.parse({
    family_id: candidate.familyId,
    source: VILLAGE_SOURCE,
    payload: {
      event_type: 'activity_signup_open',
      candidate_id: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      summary: candidate.summary,
      source_url: candidate.sourceUrl,
      coverage_note: candidate.coverageNote,
    },
    received_at: new Date().toISOString(),
  });

  // expireInSeconds (recipe #6): a killed pipeline re-queues in ~3min, not the
  // 15min default — set per-job here so it applies regardless of the queue row's
  // stored default.
  await queue.send('events.ingested', payload, { expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
  return { status: 202, payload };
}

/**
 * The set of candidate ids THIS family has already accepted (added to their
 * week). An accept re-enters the spine as a village-sourced event carrying the
 * candidate_id in its payload, which the pipeline then drafts into an action; the
 * existence of that drafted action is the durable "added to your week" signal.
 * Sourcing it from SERVER data (rather than the button's optimistic local state)
 * is what lets the accept button render "added to your week" on load and survive
 * the streamed feed remounting it.
 *
 * Joins actions → their originating event so we read candidate_id from the
 * already-stored village payload (rule #1: only the coarse candidate fields ever
 * live there). Filtered to the family's own village events so it never reflects
 * another family's accepts.
 */
export async function listFamilyAcceptedCandidateIds(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const rows = await database
    .select({ candidateId: sql<string | null>`${schema.events.payload} ->> 'candidate_id'` })
    .from(schema.actions)
    .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .where(and(eq(schema.events.familyId, familyId), eq(schema.events.source, VILLAGE_SOURCE)));

  const ids = new Set<string>();
  for (const row of rows) {
    if (row.candidateId) ids.add(row.candidateId);
  }
  return ids;
}

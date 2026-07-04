import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  FEED_EPISODE,
  HEALTH_DONE_EPISODE,
  type MarkDoneInput,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from './log-types.js';

/**
 * Pure + db helpers behind the quick-log server action. Split out of the
 * 'use server' module (which may only export async actions) so the row-shape and
 * transaction logic stay directly unit-testable with an injected db.
 */

export interface EpisodeInsert {
  familyId: string;
  childId: string | null;
  /** The parent who logged it (users.id), for the rule-#1 parent-authored
   * exemption — a parent's own log about their teen survives the redaction read
   * for its author. Null only in a preview with no resolved parent. */
  authoredBy: string | null;
  occurredAt: Date;
  episodeType: string;
  summary: string;
  payload: Record<string, unknown>;
}

/**
 * Pure: turns a validated quick-log input into the episode row to insert. The
 * summary is a plain-language one-liner; the structured fields live in payload so
 * the Coach and Memory Inferencer can read them (amountMl / durationMin /
 * milestone). `authoredBy` stamps the acting parent so the teen-redaction read can
 * exempt a parent's own log about their teen (rule #1, policy: parent-authored).
 */
export function buildEpisodeInsert(
  input: QuickLogInput,
  familyId: string,
  occurredAt: Date,
  authoredBy: string | null,
): EpisodeInsert {
  const base = { familyId, childId: input.childId, authoredBy, occurredAt };
  switch (input.kind) {
    case FEED_EPISODE:
      return {
        ...base,
        episodeType: FEED_EPISODE,
        summary: input.feedKind ? `Fed ${input.amountMl} ml (${input.feedKind})` : `Fed ${input.amountMl} ml`,
        payload: {
          amountMl: input.amountMl,
          ...(input.feedKind ? { feedKind: input.feedKind } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      };
    case NAP_EPISODE:
      return {
        ...base,
        episodeType: NAP_EPISODE,
        summary: `Napped ${input.durationMin} min`,
        payload: input.note
          ? { durationMin: input.durationMin, note: input.note }
          : { durationMin: input.durationMin },
      };
    case MILESTONE_EPISODE:
      return {
        ...base,
        episodeType: MILESTONE_EPISODE,
        summary: input.milestone,
        payload: {
          milestone: input.milestone,
          ...(input.note ? { note: input.note } : {}),
        },
      };
  }
}

/**
 * Pure: turns a done-tap on a curated companion item into the episode row to
 * insert. A milestone done produces the SAME row a quick-log milestone writes
 * (episodeType 'milestone', summary = what, payload.milestone = what) so the
 * companion read flips it to done by matching that `what`. A health done produces
 * a 'health_done' episode carrying the stable healthKey in its payload so the read
 * joins it back to the curated schedule item. Both reuse writeEpisode downstream.
 */
export function buildDoneEpisodeInsert(
  input: MarkDoneInput,
  familyId: string,
  occurredAt: Date,
  authoredBy: string | null,
): EpisodeInsert {
  if (input.target === 'milestone') {
    return buildEpisodeInsert(
      { kind: MILESTONE_EPISODE, childId: input.childId, milestone: input.what },
      familyId,
      occurredAt,
      authoredBy,
    );
  }
  return {
    familyId,
    childId: input.childId,
    authoredBy,
    occurredAt,
    episodeType: HEALTH_DONE_EPISODE,
    summary: `${input.what} — done`,
    payload: { healthKey: input.healthKey, what: input.what },
  };
}

/**
 * Confirms the child belongs to the family before any write — a parent may only
 * log against their own children (rule #1, fail closed). Returns false when the
 * child id belongs to another family or no longer exists.
 */
export async function childBelongsToFamily(
  database: Database,
  familyId: string,
  childId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Persists an episode row plus its immutable audit_log row in one transaction
 * (rule #6). The actor is the family — a quick-log is the parent's own household
 * write, not an agent run.
 */
export async function writeEpisode(database: Database, episode: EpisodeInsert): Promise<void> {
  await database.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.familyMemoryEpisodes)
      .values(episode)
      .returning({ id: schema.familyMemoryEpisodes.id });

    const episodeId = inserted[0]?.id;
    if (!episodeId) {
      throw new Error('writeEpisode: episode insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: episode.familyId,
      actor: episode.familyId,
      actionTaken: `quick_log_${episode.episodeType}`,
      targetTable: 'family_memory_episodes',
      targetId: episodeId,
    });
  });
}

/** The editable fields of a logged episode. Only the columns a parent can revise
 * from the logs view — the audit-relevant ones (when it happened, its summary,
 * and the structured payload). id/family/type are fixed. */
export interface EpisodePatch {
  occurredAt?: Date;
  summary?: string;
  payload?: Record<string, unknown>;
}

/** The audit-relevant snapshot of an episode, used for the before/after rows. */
interface EpisodeSnapshot {
  occurredAt: Date;
  summary: string;
  payload: Record<string, unknown>;
}

const TARGET_TABLE = 'family_memory_episodes';

/** The transaction handle passed to database.transaction's callback — narrower
 * than Database (no $client), so a tx-scoped helper must take this, not Database. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Edits a parent's own logged episode. Family-scoped (rule #1): the row is read
 * and updated WHERE id = ? AND family_id = ? — a foreign episode matches nothing,
 * so the function returns false and writes nothing. On a match it snapshots the
 * before-state, applies the patch, and writes ONE immutable audit_log row carrying
 * before + after (rule #6) inside the same transaction as the update. The audit
 * actor is the editing parent's user id.
 */
export async function updateEpisode(
  database: Database,
  id: string,
  familyId: string,
  patch: EpisodePatch,
  actor: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const before = await loadEpisodeSnapshot(tx, id, familyId);
    if (!before) return false;

    const updated = await tx
      .update(schema.familyMemoryEpisodes)
      .set(patch)
      .where(
        and(
          eq(schema.familyMemoryEpisodes.id, id),
          eq(schema.familyMemoryEpisodes.familyId, familyId),
        ),
      )
      .returning({ id: schema.familyMemoryEpisodes.id });
    if (updated.length === 0) return false;

    const after: EpisodeSnapshot = {
      occurredAt: patch.occurredAt ?? before.occurredAt,
      summary: patch.summary ?? before.summary,
      payload: patch.payload ?? before.payload,
    };

    await tx.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: 'quick_log_edited',
      targetTable: TARGET_TABLE,
      targetId: id,
      before,
      after,
    });
    return true;
  });
}

/**
 * Soft-deletes a parent's own logged episode: stamps deleted_at rather than
 * issuing a DELETE, so the row the audit trail references stays intact (rules #6,
 * #9). Family-scoped like updateEpisode — a foreign episode matches nothing and
 * returns false with no write. Writes ONE audit_log row (before = the removed row,
 * after = { deleted: true }) in the same transaction.
 */
export async function softDeleteEpisode(
  database: Database,
  id: string,
  familyId: string,
  actor: string,
  now: Date = new Date(),
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const before = await loadEpisodeSnapshot(tx, id, familyId);
    if (!before) return false;

    const updated = await tx
      .update(schema.familyMemoryEpisodes)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.familyMemoryEpisodes.id, id),
          eq(schema.familyMemoryEpisodes.familyId, familyId),
        ),
      )
      .returning({ id: schema.familyMemoryEpisodes.id });
    if (updated.length === 0) return false;

    await tx.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: 'quick_log_deleted',
      targetTable: TARGET_TABLE,
      targetId: id,
      before,
      after: { deleted: true },
    });
    return true;
  });
}

/**
 * Reads the audit-relevant fields of a LIVE (not already-deleted) episode,
 * family-scoped. Returns null when no such row belongs to the family — the family
 * scope check that makes edit/delete reject a foreign episode (rule #1).
 */
async function loadEpisodeSnapshot(
  tx: Tx,
  id: string,
  familyId: string,
): Promise<EpisodeSnapshot | null> {
  const rows = await tx
    .select({
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
      summary: schema.familyMemoryEpisodes.summary,
      payload: schema.familyMemoryEpisodes.payload,
    })
    .from(schema.familyMemoryEpisodes)
    .where(
      and(
        eq(schema.familyMemoryEpisodes.id, id),
        eq(schema.familyMemoryEpisodes.familyId, familyId),
        isNull(schema.familyMemoryEpisodes.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { occurredAt: row.occurredAt, summary: row.summary, payload: row.payload };
}

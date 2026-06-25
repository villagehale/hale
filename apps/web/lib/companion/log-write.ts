import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { FEED_EPISODE, MILESTONE_EPISODE, NAP_EPISODE, type QuickLogInput } from './log-types.js';

/**
 * Pure + db helpers behind the quick-log server action. Split out of the
 * 'use server' module (which may only export async actions) so the row-shape and
 * transaction logic stay directly unit-testable with an injected db.
 */

export interface EpisodeInsert {
  familyId: string;
  childId: string | null;
  occurredAt: Date;
  episodeType: string;
  summary: string;
  payload: Record<string, unknown>;
}

/**
 * Pure: turns a validated quick-log input into the episode row to insert. The
 * summary is a plain-language one-liner; the structured fields live in payload so
 * the Coach and Memory Inferencer can read them (amountMl / durationMin /
 * milestone).
 */
export function buildEpisodeInsert(
  input: QuickLogInput,
  familyId: string,
  occurredAt: Date,
): EpisodeInsert {
  const base = { familyId, childId: input.childId, occurredAt };
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

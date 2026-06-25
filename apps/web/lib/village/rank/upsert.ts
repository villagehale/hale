import { pickModel } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { readVillage } from '../queries';
import { rankRecommendations } from './rank';
import { loadRankSkill } from './skill';

/**
 * The BACKGROUND rank materializer. Fan-out-on-WRITE: the drain runs this when a
 * family's candidate set may have changed (a discovery, an endorsement) and
 * stores the agent-decided order in village_feed_rank, so the home feed read is a
 * pure DB lookup and the ~25s ranker never lands in the request path.
 *
 * Spend guard (rule #7): the candidate ids are read in the SAME discovery order
 * the feed read uses, joined into a fingerprint. If the stored row already has
 * that fingerprint the candidate set is unchanged and we short-circuit BEFORE any
 * model call — the agent re-runs only on a real change. Fewer than two candidates
 * is nothing to rank, so it skips too (the read path serves the discovery order
 * directly). The existing rankRecommendations is reused UNCHANGED.
 */

export type UpsertFeedRankOutcome = 'ranked' | 'unchanged' | 'skipped';

/** Injected so the short-circuit decision is unit-testable without a real db or a
 * real LLM (rule #8 — the LLM is never mocked into the rank eval; the rank
 * FUNCTION boundary is injected here instead). */
export interface UpsertFeedRankDeps {
  /** Candidate ids in the feed's discovery order (the fingerprint basis). */
  loadCandidateIds: (database: Database, familyId: string) => Promise<string[]>;
  /** The stored rank row's fingerprint, or null when the family has none yet. */
  loadExistingRank: (
    database: Database,
    familyId: string,
  ) => Promise<{ fingerprint: string } | null>;
  rank: typeof rankRecommendations;
  /** The model tier the ranker runs on — recorded on the row. */
  resolveModel: () => Promise<string>;
  upsert: (row: {
    familyId: string;
    orderedIds: string[];
    fingerprint: string;
    modelUsed: string;
  }) => Promise<void>;
}

async function defaultLoadCandidateIds(database: Database, familyId: string): Promise<string[]> {
  const { candidates } = await readVillage(database, familyId);
  return candidates.map((c) => c.id);
}

async function defaultLoadExistingRank(
  database: Database,
  familyId: string,
): Promise<{ fingerprint: string } | null> {
  const rows = await database
    .select({ fingerprint: schema.villageFeedRank.fingerprint })
    .from(schema.villageFeedRank)
    .where(eq(schema.villageFeedRank.familyId, familyId))
    .limit(1);
  return rows[0] ?? null;
}

async function defaultResolveModel(): Promise<string> {
  const skill = await loadRankSkill();
  return pickModel(skill.meta.task);
}

function defaultUpsert(database: Database) {
  return async (row: {
    familyId: string;
    orderedIds: string[];
    fingerprint: string;
    modelUsed: string;
  }): Promise<void> => {
    await database
      .insert(schema.villageFeedRank)
      .values({
        familyId: row.familyId,
        orderedIds: row.orderedIds,
        fingerprint: row.fingerprint,
        modelUsed: row.modelUsed,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.villageFeedRank.familyId,
        set: {
          orderedIds: row.orderedIds,
          fingerprint: row.fingerprint,
          modelUsed: row.modelUsed,
          computedAt: new Date(),
        },
      });
  };
}

export function defaultUpsertFeedRankDeps(database: Database): UpsertFeedRankDeps {
  return {
    loadCandidateIds: defaultLoadCandidateIds,
    loadExistingRank: defaultLoadExistingRank,
    rank: rankRecommendations,
    resolveModel: defaultResolveModel,
    upsert: defaultUpsert(database),
  };
}

export async function upsertFeedRank(
  database: Database,
  familyId: string,
  deps: UpsertFeedRankDeps = defaultUpsertFeedRankDeps(database),
): Promise<UpsertFeedRankOutcome> {
  const candidateIds = await deps.loadCandidateIds(database, familyId);
  if (candidateIds.length < 2) {
    return 'skipped';
  }

  const fingerprint = candidateIds.join(',');
  const existing = await deps.loadExistingRank(database, familyId);
  if (existing?.fingerprint === fingerprint) {
    return 'unchanged';
  }

  const { orderedIds } = await deps.rank({ familyId, candidateIds, actor: 'system' }, database);
  await deps.upsert({
    familyId,
    orderedIds,
    fingerprint,
    modelUsed: await deps.resolveModel(),
  });
  return 'ranked';
}

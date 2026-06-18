import { type Database, schema } from '@hale/db';
import { type FamilyStage, deriveStage } from '@hale/types';
import { eq } from 'drizzle-orm';
import { type DiscoveryDeps, runDiscovery } from '../agents/discovery.js';
import { runRoutine } from '../agents/routine.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { recordDiscovery, recordRoutineProposal } from './memory-writer.js';

interface VillageDiscoveryJob {
  familyId: string;
  weekOf: string; // YYYY-MM-DD, the Monday of the routine week (set at enqueue, like digestDate).
}

/** Candidates carry no category column; persisted under one honest label. */
const CANDIDATE_KIND = 'activity';

/**
 * Scheduled village discovery for one family: discover stage-appropriate local
 * activities (Fake provider by default, web-grounded behind a flag), arrange a
 * stage-aware weekly routine, and persist both via the memory writer (each write
 * carries its own audit row — rule #6).
 *
 * Privacy (rule #1): only the COARSE area reaches the provider and the logs;
 * never a child name, DOB, or precise location. A family with no opted-in
 * `areaCoarse` is skipped — discovery needs a coarse area to run at all.
 * Candidates are persisted family-wide (childId null): the providers return
 * stage-typical activity types, not child-pinpointed listings.
 *
 * Teen exclusion (rule #1): these candidates feed a PUBLIC share page, so a
 * teenager's stage is never queried and their interests never enter the pool —
 * teens are dropped at the source. A teen-only family yields no discovery inputs
 * and is skipped entirely (nothing written).
 */

/**
 * The discovery inputs for a family, derived from NON-TEEN children only
 * (rule #1). Empty `stages` means there is nothing to discover for the public
 * pool — the caller skips discovery and routine generation.
 */
export function selectDiscoveryInputs(
  children: ReadonlyArray<{ dateOfBirth: string | Date; interests: string[] }>,
  now: Date = new Date(),
): { stages: FamilyStage[]; interests: string[] } {
  const nonTeen = children.filter((c) => deriveStage(c.dateOfBirth, now) !== 'teenager');
  const stages = [...new Set<FamilyStage>(nonTeen.map((c) => deriveStage(c.dateOfBirth, now)))];
  const interests = [...new Set(nonTeen.flatMap((c) => c.interests))];
  return { stages, interests };
}

export async function runVillageDiscovery(
  job: VillageDiscoveryJob,
  database: Database = db(),
  discoveryDeps?: DiscoveryDeps,
): Promise<void> {
  const familyRows = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, job.familyId))
    .limit(1);
  const family = familyRows[0];
  if (!family) {
    throw new Error(`runVillageDiscovery: no family row for ${job.familyId}`);
  }
  if (!family.areaCoarse) {
    logger.info({ familyId: job.familyId }, 'village discovery skipped: no coarse area');
    return;
  }
  const areaCoarse = family.areaCoarse;

  const childRows = await database
    .select({
      dateOfBirth: schema.children.dateOfBirth,
      interests: schema.children.interests,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, job.familyId));

  const { stages: discoveryStages, interests } = selectDiscoveryInputs(childRows);
  if (discoveryStages.length === 0) {
    logger.info(
      { familyId: job.familyId },
      'village discovery skipped: no non-teen children to discover for',
    );
    return;
  }
  const primaryStage = discoveryStages[0] as FamilyStage;

  logger.info(
    {
      familyId: job.familyId,
      areaCoarse,
      stages: discoveryStages,
      provider: discoveryDeps?.provider.name,
    },
    'village discovery: running',
  );

  const candidates: Awaited<ReturnType<typeof runDiscovery>>['candidates'] = [];
  let provider = 'fake';
  for (const stage of discoveryStages) {
    const result = await runDiscovery(
      { familyId: job.familyId, areaCoarse, stage, interests },
      discoveryDeps,
    );
    provider = result.provider;
    candidates.push(...result.candidates);
  }

  await recordDiscovery({
    familyId: job.familyId,
    areaCoarse,
    provider,
    candidates: candidates.map((c) => ({
      title: c.title,
      kind: CANDIDATE_KIND,
      summary: c.description,
      sourceUrl: c.sourceUrl,
      source: c.source,
      confidence: c.confidence,
      coverageNote: c.coverageNote,
      childId: null,
    })),
  });

  const routine = await runRoutine({ stage: primaryStage, candidates, interests });

  await recordRoutineProposal({
    familyId: job.familyId,
    weekOf: job.weekOf,
    items: routine.routine.map((item) => ({
      title: item.title,
      kind: item.category,
      childId: null,
      stageNote: item.stageFitRationale,
    })),
  });

  logger.info(
    {
      familyId: job.familyId,
      candidateCount: candidates.length,
      routineItems: routine.routine.length,
    },
    'village discovery generated',
  );
}

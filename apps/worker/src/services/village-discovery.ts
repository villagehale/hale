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
 */
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

  const stages: FamilyStage[] = childRows.map((c) => deriveStage(c.dateOfBirth));
  const distinctStages = [...new Set<FamilyStage>(stages)];
  const primaryStage: FamilyStage = distinctStages[0] ?? 'newborn';
  const discoveryStages = distinctStages.length > 0 ? distinctStages : [primaryStage];
  const interests = [...new Set(childRows.flatMap((c) => c.interests))];

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

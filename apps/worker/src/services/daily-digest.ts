import { and, eq, gte, lt } from 'drizzle-orm';
import { schema, type Database } from '@hearth/db';
import { db } from '../db.js';
import { logger } from '../logger.js';

interface DailyDigestJob {
  familyId: string;
  digestDate: string; // YYYY-MM-DD
}

/**
 * Builds the daily digest for a family by reading the day's actions and writing
 * one daily_digests summary row the web app renders. Idempotent per day: the
 * unique (family_id, digest_date) index upserts the row on a re-run rather than
 * duplicating it, so a redelivered digest job recomputes the same row.
 */
export async function runDailyDigest(
  job: DailyDigestJob,
  database: Database = db(),
): Promise<void> {
  const dayStart = new Date(`${job.digestDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const todayActions = await database
    .select({
      id: schema.actions.id,
      actionType: schema.actions.actionType,
      userVisibleState: schema.actions.userVisibleState,
      executedAt: schema.actions.executedAt,
    })
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.familyId, job.familyId),
        gte(schema.actions.draftedAt, dayStart),
        lt(schema.actions.draftedAt, dayEnd),
      ),
    );

  const counts = {
    autonomous: 0,
    drafted: 0,
    needsHuman: 0,
    reverted: 0,
  };

  for (const action of todayActions) {
    switch (action.userVisibleState) {
      case 'autonomous':
        counts.autonomous++;
        break;
      case 'drafted_for_approval':
        counts.drafted++;
        break;
      case 'needs_human':
        counts.needsHuman++;
        break;
      case 'reverted':
        counts.reverted++;
        break;
    }
  }

  await database
    .insert(schema.dailyDigests)
    .values({
      familyId: job.familyId,
      digestDate: job.digestDate,
      handledCount: counts.autonomous,
      awaitingCount: counts.drafted,
      needsYouCount: counts.needsHuman,
      revertedCount: counts.reverted,
      totalCount: todayActions.length,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.dailyDigests.familyId, schema.dailyDigests.digestDate],
      set: {
        handledCount: counts.autonomous,
        awaitingCount: counts.drafted,
        needsYouCount: counts.needsHuman,
        revertedCount: counts.reverted,
        totalCount: todayActions.length,
        generatedAt: new Date(),
      },
    });

  logger.info(
    { familyId: job.familyId, date: job.digestDate, total: todayActions.length, counts },
    'daily digest generated',
  );
}

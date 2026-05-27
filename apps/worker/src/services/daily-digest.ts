import { and, eq, gte, lt } from 'drizzle-orm';
import { schema } from '@mira/db';
import { db } from '../db.js';
import { logger } from '../logger.js';

interface DailyDigestJob {
  familyId: string;
  digestDate: string; // YYYY-MM-DD
}

/**
 * Builds the daily digest for a family by reading today's actions
 * (autonomous, drafted_for_approval, needs_human) and writing a summary
 * row that the web app renders.
 *
 * Current implementation: pulls actions, logs counts. The summary table
 * write lands when `daily_digests` is added to the schema (next migration);
 * the read path is already real and exposes per-family activity counts.
 */
export async function runDailyDigest(job: DailyDigestJob): Promise<void> {
  const dayStart = new Date(`${job.digestDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const todayActions = await db()
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

  logger.info(
    { familyId: job.familyId, date: job.digestDate, total: todayActions.length, counts },
    'daily digest generated',
  );
}

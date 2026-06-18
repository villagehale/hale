import { and, eq, gte, lt } from 'drizzle-orm';
import { schema, type Database, type DigestPerChildBreakdown } from '@hale/db';
import { companionForChild } from '@hale/types';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { detectSiblingCalendarOverlaps } from './sibling-overlap.js';

interface DailyDigestJob {
  familyId: string;
  digestDate: string; // YYYY-MM-DD
}

type CompanionHighlights = NonNullable<DigestPerChildBreakdown['companionHighlights']>;

/** A health item this coarse window counts as "soon" for a daily-brief nudge. */
const HEALTH_SOON_WEEKS = 6;

/**
 * Personalized child-development nudges for the daily brief, derived per child
 * from date_of_birth via the deterministic companion (no LLM). Each child gets
 * up to one soon-due routine health item and one milestone worth watching this
 * stage. Supportive, never diagnostic (rule #1); a child with nothing soon is
 * omitted rather than padded. `now` is injectable for deterministic tests.
 */
export function companionHighlightsForChildren(
  children: ReadonlyArray<{ id: string; name: string; dateOfBirth: string }>,
  now: Date = new Date(),
): CompanionHighlights {
  const highlights: CompanionHighlights = [];

  for (const child of children) {
    const view = companionForChild({ dateOfBirth: child.dateOfBirth, name: child.name }, now);
    const notes: string[] = [];

    const soon = view.nextHealth.find((item) => item.dueInWeeks <= HEALTH_SOON_WEEKS);
    if (soon) {
      const when =
        soon.dueInWeeks <= 0
          ? 'due now'
          : `due in ${soon.dueInWeeks} ${soon.dueInWeeks === 1 ? 'week' : 'weeks'}`;
      notes.push(`${child.name}'s ${soon.what} are ${when}`);
    }

    const watch = view.milestones.find((m) => m.timing === 'in_window');
    if (watch) {
      notes.push(`watch for "${watch.what.toLowerCase()}" around this stage`);
    }

    if (notes.length > 0) {
      highlights.push({ childId: child.id, name: child.name, notes });
    }
  }

  return highlights;
}

interface StateCounts {
  handledCount: number;
  awaitingCount: number;
  needsYouCount: number;
  revertedCount: number;
  totalCount: number;
}

function emptyCounts(): StateCounts {
  return { handledCount: 0, awaitingCount: 0, needsYouCount: 0, revertedCount: 0, totalCount: 0 };
}

function tallyInto(counts: StateCounts, userVisibleState: string): void {
  counts.totalCount++;
  switch (userVisibleState) {
    case 'autonomous':
      counts.handledCount++;
      break;
    case 'drafted_for_approval':
      counts.awaitingCount++;
      break;
    case 'needs_human':
      counts.needsYouCount++;
      break;
    case 'reverted':
      counts.revertedCount++;
      break;
  }
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

  // Join each action to its event's child_id (and the action payload, for the
  // calendar-overlap detector). LEFT-join semantics aren't needed — every action
  // has an event (FK NOT NULL) — but child_id is nullable (family-wide /
  // undeterminable), which feeds the unattributed bucket.
  const todayActions = await database
    .select({
      id: schema.actions.id,
      actionType: schema.actions.actionType,
      payload: schema.actions.payload,
      userVisibleState: schema.actions.userVisibleState,
      childId: schema.events.childId,
    })
    .from(schema.actions)
    .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .where(
      and(
        eq(schema.actions.familyId, job.familyId),
        gte(schema.actions.draftedAt, dayStart),
        lt(schema.actions.draftedAt, dayEnd),
      ),
    );

  const familyTotals = emptyCounts();
  const perChild = new Map<string, StateCounts>();
  const unattributed = emptyCounts();

  for (const action of todayActions) {
    tallyInto(familyTotals, action.userVisibleState);
    if (action.childId) {
      let bucket = perChild.get(action.childId);
      if (!bucket) {
        bucket = emptyCounts();
        perChild.set(action.childId, bucket);
      }
      tallyInto(bucket, action.userVisibleState);
    } else {
      tallyInto(unattributed, action.userVisibleState);
    }
  }

  // Per-child sections need each attributed child's name, and the companion
  // highlights need every child's date_of_birth (whether or not they had an
  // action today) — one scoped query serves both.
  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, job.familyId));
  const nameById = new Map(childRows.map((c) => [c.id, c.name]));

  const companionHighlights = companionHighlightsForChildren(
    childRows,
    new Date(`${job.digestDate}T00:00:00.000Z`),
  );

  const coordinationFlags = detectSiblingCalendarOverlaps(
    todayActions.map((a) => ({
      actionId: a.id,
      childId: a.childId,
      actionType: a.actionType,
      payload: a.payload,
    })),
  );

  const perChildBreakdown: DigestPerChildBreakdown = {
    children: [...perChild.entries()].map(([childId, counts]) => ({
      childId,
      name: nameById.get(childId) ?? 'Unknown',
      ...counts,
    })),
    unattributed,
    coordinationFlags,
    companionHighlights,
  };

  const row = {
    handledCount: familyTotals.handledCount,
    awaitingCount: familyTotals.awaitingCount,
    needsYouCount: familyTotals.needsYouCount,
    revertedCount: familyTotals.revertedCount,
    totalCount: familyTotals.totalCount,
    perChildBreakdown,
    generatedAt: new Date(),
  };

  await database
    .insert(schema.dailyDigests)
    .values({ familyId: job.familyId, digestDate: job.digestDate, ...row })
    .onConflictDoUpdate({
      target: [schema.dailyDigests.familyId, schema.dailyDigests.digestDate],
      set: row,
    });

  logger.info(
    {
      familyId: job.familyId,
      date: job.digestDate,
      total: familyTotals.totalCount,
      childCount: perChild.size,
      coordinationFlags: coordinationFlags.length,
    },
    'daily digest generated',
  );
}

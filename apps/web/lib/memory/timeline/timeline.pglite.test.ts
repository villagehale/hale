import { schema } from '@hale/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETION_GRACE_MS, runDeletionSweep, scheduleFamilyDeletion } from '~/lib/rights/delete';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { HORIZONS, type Horizon, TIMELINES } from './fixtures';
import { type ReplayedFamily, horizonNow, readBack, replayTimeline } from './replay';
import { type TimelineScore, scoreTimeline, totalScores } from './score';

/**
 * VIL-598 leg A · the family memory timeline gate. Eight invented families, each
 * replayed at a week, six weeks and six months, read back through every prompt path.
 * No model runs, so it gates every PR: leaks 0, stale values 0, contradictions 0,
 * every forget and delete held, the export carrying every row, and every current
 * value reaching each prompt that should read it.
 */

let db: TestDb;
const scores: TimelineScore[] = [];
const sixMonthFamilies: ReplayedFamily[] = [];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  const totals = totalScores(scores);
  // Counts only: the fixtures are invented, but a gate log carries no memory text.
  console.info({ ...totals }, 'family memory timeline eval (leg A)');
  await db.close();
});

const horizons = Object.keys(HORIZONS) as Horizon[];

describe.each(TIMELINES.map((timeline) => [timeline.id, timeline] as const))(
  'timeline %s',
  (_id, timeline) => {
    it.each(horizons)('at %s', async (horizon) => {
      const family = await replayTimeline(db.database, timeline, horizon);
      expect(family.replayErrors).toEqual([]);
      if (horizon === '6m') sixMonthFamilies.push(family);
      const readback = await readBack(db.database, timeline, family, horizonNow(horizon));
      const score = scoreTimeline({ timeline, horizon, ...readback });
      scores.push(score);

      expect(score.vacuous).toEqual([]);
      expect(score.leaks).toEqual([]);
      expect(score.stale).toEqual([]);
      expect(score.contradictions).toEqual([]);
      expect(score.exportMisses).toEqual([]);
      expect(score.recallMisses).toEqual([]);
      expect(score.erasure.held).toBe(score.erasure.expected);
    });
  },
);

describe('the gate totals', () => {
  it('scored every timeline at every horizon, with every kind of probe planted', () => {
    const totals = totalScores(scores);
    expect(totals.runs).toBe(TIMELINES.length * horizons.length);
    // Positive controls for the totals themselves: a gate that planted nothing passes.
    expect(totals.recallExpected).toBeGreaterThan(100);
    expect(totals.erasureExpected).toBe(9);
    const planted = new Set(
      TIMELINES.flatMap((t) => t.probes.map((p) => (p.kind === 'secret' ? p.secret : p.kind))),
    );
    expect([...planted].sort()).toEqual(
      [
        'coparentExport',
        'correction',
        'current',
        'deleted',
        'forgotten',
        'injection',
        'stale',
        'teen',
        'third_party',
      ].sort(),
    );
  });

  it('a family erasure leaves none of its memory or raw inputs behind', async () => {
    const familyIds = sixMonthFamilies.map((family) => family.familyId);
    expect(familyIds).toHaveLength(TIMELINES.length);
    const now = horizonNow('6m');
    for (const family of sixMonthFamilies) {
      await scheduleFamilyDeletion(db.database, {
        familyId: family.familyId,
        actorUserId: family.parentUserId,
        now,
      });
    }
    const counts = async () => {
      const [facts, episodes, events, conversations] = await Promise.all([
        db.database
          .select({ id: schema.familyMemoryFacts.id })
          .from(schema.familyMemoryFacts)
          .where(inArray(schema.familyMemoryFacts.familyId, familyIds)),
        db.database
          .select({ id: schema.familyMemoryEpisodes.id })
          .from(schema.familyMemoryEpisodes)
          .where(inArray(schema.familyMemoryEpisodes.familyId, familyIds)),
        db.database
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(inArray(schema.events.familyId, familyIds)),
        db.database
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(inArray(schema.conversations.familyId, familyIds)),
      ]);
      return {
        facts: facts.length,
        episodes: episodes.length,
        events: events.length,
        conversations: conversations.length,
      };
    };
    const before = await counts();
    // Positive control: there was memory to erase.
    expect(before.facts).toBeGreaterThan(0);
    expect(before.episodes).toBeGreaterThan(0);
    expect(before.events).toBeGreaterThan(0);
    expect(before.conversations).toBe(TIMELINES.length);

    const summary = await runDeletionSweep(
      db.database,
      new Date(now.getTime() + DELETION_GRACE_MS + 60_000),
      async () => {},
      async () => ({ posted: 0, deduped: 0, failed: 0 }),
    );
    expect(summary.erased).toBe(TIMELINES.length);
    expect(await counts()).toEqual({ facts: 0, episodes: 0, events: 0, conversations: 0 });
  });
});

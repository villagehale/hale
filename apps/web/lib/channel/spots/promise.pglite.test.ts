import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { resettleSpotWatchPromise } from './promise';
import { armWatchedSpot, markNotifiedAndRelease, releaseWatchedSpot } from './store';

/**
 * The spot-watch promise against the REAL open-loops ledger, because the whole module is
 * about ROWS other surfaces query: one open promise per family enforced by a partial
 * unique index, a closure that must be complete, and a re-record whose due date decides
 * whether the founder digest reads a household as overdue. A store fake proves none of
 * that — it returns whatever it was handed, so a resettle that wrote nothing at all would
 * pass.
 *
 * Each test names the mutation it exists to catch.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const T0 = new Date('2026-09-04T14:00:00.000Z');
const T1 = new Date(T0.getTime() + 86_400_000);
const T2 = new Date(T0.getTime() + 2 * 86_400_000);
const RELEASED_AT = new Date(T0.getTime() + 3 * 86_400_000);

/** One watch on its own page, armed at its own instant so the expiries differ — which is
 * what makes "the SOONEST remaining watch" a question with a wrong answer. */
async function armCourse(
  family: { familyId: string; parentUserId: string },
  courseId: string,
  now: Date,
  channelMessageId: string,
): Promise<{ spotId: string; expiresAt: Date }> {
  const armed = await armWatchedSpot(db.database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    intent: {
      url: `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=${courseId}`,
      host: 'cityofmarkham.perfectmind.com',
      portalLabel: 'the Markham portal',
      label: 'Milliken preschool swim',
      instant: false,
      lastState: 'full',
    },
    channelMessageId,
    now,
  });
  if (armed.status !== 'armed') throw new Error(`unreachable: the arm was ${armed.status}`);
  const [row] = await db.database
    .select({ expiresAt: schema.watchedSpots.expiresAt })
    .from(schema.watchedSpots)
    .where(eq(schema.watchedSpots.id, armed.spotId));
  if (!row) throw new Error('unreachable: the armed watch could not be read back');
  return { spotId: armed.spotId, expiresAt: row.expiresAt };
}

async function promisesOf(familyId: string) {
  return db.database
    .select({
      createdFrom: schema.agentCommitments.createdFrom,
      dueAt: schema.agentCommitments.dueAt,
      fulfilledAt: schema.agentCommitments.fulfilledAt,
      fulfilledBy: schema.agentCommitments.fulfilledBy,
      cancelledAt: schema.agentCommitments.cancelledAt,
      cancelledReason: schema.agentCommitments.cancelledReason,
    })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, familyId));
}

describe('resettleSpotWatchPromise', () => {
  /** The whole reason a release has to touch the ledger at all: overdue is a QUERY on
   * `due_at`, so a promise left due at the ENDED watch's expiry reads as a broken promise
   * while Hale is still watching two other pages, on time. Catches deleting the re-record,
   * and catches re-recording against the LAST-expiring watch instead of the soonest. */
  it('voids the promise and re-opens it against the soonest watch still live', async () => {
    const family = await seedFamily(db.database, 'Resettle Family');
    const first = await armCourse(family, 'course-a', T0, 'CM-A');
    const second = await armCourse(family, 'course-b', T1, 'CM-B');
    await armCourse(family, 'course-c', T2, 'CM-C');

    await releaseWatchedSpot(db.database, {
      spotId: first.spotId,
      reason: 'expired',
      now: RELEASED_AT,
    });
    await resettleSpotWatchPromise(db.database, {
      familyId: family.familyId,
      keptBy: null,
      cancelReason: 'spot_watch_ended',
      now: RELEASED_AT,
    });

    const rows = await promisesOf(family.familyId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.createdFrom === 'CM-A')).toMatchObject({
      dueAt: first.expiresAt,
      cancelledAt: RELEASED_AT,
      cancelledReason: 'spot_watch_ended',
      fulfilledAt: null,
    });
    expect(rows.find((row) => row.createdFrom === 'CM-B')).toMatchObject({
      dueAt: second.expiresAt,
      cancelledAt: null,
      fulfilledAt: null,
    });
  });

  /** The one ending that KEPT it, and the only one: the promise says a text will arrive,
   * so it is closed by the id of the text whose receipt landed. Catches a resettle that
   * cancels regardless of `keptBy`, a fulfilment with nothing to point at (the schema's
   * closure check refuses it, so the row would stay open), and a re-record fired with no
   * watch left to be due at. */
  it('keeps the promise by the message that carried the opening, and re-opens nothing', async () => {
    const family = await seedFamily(db.database, 'Kept Promise Family');
    const only = await armCourse(family, 'course-only', T0, 'CM-ONLY');

    await markNotifiedAndRelease(db.database, { spotId: only.spotId, now: RELEASED_AT });
    await resettleSpotWatchPromise(db.database, {
      familyId: family.familyId,
      keptBy: 'CM-OPEN',
      cancelReason: 'spot_watch_ended',
      now: RELEASED_AT,
    });

    const rows = await promisesOf(family.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      createdFrom: 'CM-ONLY',
      fulfilledAt: RELEASED_AT,
      fulfilledBy: 'CM-OPEN',
      cancelledAt: null,
      cancelledReason: null,
    });
  });

  /** A household whose arming-time ledger write was lost is still being watched, and the
   * ledger still owes it a promise. `none_open` is therefore a pass-through and only
   * `not_closed` — a write that FAILED — stops the resettle: the household comes out of a
   * release owing exactly what it is owed. Catches an early return on any status but
   * 'closed'. */
  it('re-opens the promise even when the closure found nothing open', async () => {
    const family = await seedFamily(db.database, 'Lost Promise Family');
    const first = await armCourse(family, 'course-a', T0, 'CM-A');
    const second = await armCourse(family, 'course-b', T1, 'CM-B');
    await db.database
      .delete(schema.agentCommitments)
      .where(eq(schema.agentCommitments.familyId, family.familyId));

    await releaseWatchedSpot(db.database, {
      spotId: first.spotId,
      reason: 'expired',
      now: RELEASED_AT,
    });
    await resettleSpotWatchPromise(db.database, {
      familyId: family.familyId,
      keptBy: null,
      cancelReason: 'spot_watch_ended',
      now: RELEASED_AT,
    });

    const rows = await promisesOf(family.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      createdFrom: 'CM-B',
      dueAt: second.expiresAt,
      cancelledAt: null,
      fulfilledAt: null,
    });
  });
});

import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import {
  armWatchedSpot,
  claimOpenTransition,
  claimSendAttempt,
  closeBeforeSend,
  loadDueSpots,
  loadSpotById,
  releaseWatchedSpot,
  type SpotWatchIntent,
} from './store';

/**
 * The watched-spots store against the REAL DDL (migration 0109). Everything this module
 * is for lives in SQL — a partial unique index, two guarded UPDATEs, four CHECKs and a
 * cascade — and none of it is observable through a Drizzle chain fake: a fake returns
 * whatever rows it was handed, so it passes just as happily with no WHERE clause at all.
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

const NOW = new Date('2026-09-04T14:00:00.000Z');

function intent(overrides: Partial<SpotWatchIntent> = {}): SpotWatchIntent {
  return {
    url: 'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=22222222-2222-2222-2222-222222222222',
    host: 'cityofmarkham.perfectmind.com',
    portalLabel: 'the Markham portal',
    label: 'Milliken preschool swim',
    instant: false,
    lastState: 'full',
    ...overrides,
  };
}

async function arm(
  familyId: string,
  parentUserId: string,
  overrides: Partial<SpotWatchIntent> = {},
  channelMessageId: string | null = 'CM-ack',
) {
  return armWatchedSpot(db.database, {
    familyId,
    parentUserId,
    intent: intent(overrides),
    channelMessageId,
    now: NOW,
  });
}

describe('armWatchedSpot', () => {
  /** Catches a SELECT-then-INSERT guard, and a unique index that is not partial (the
   * released watch would then be un-re-armable forever). */
  it('permits one live watch per (family, url), and re-arms the page after a release', async () => {
    const family = await seedFamily(db.database, 'Arm Family');

    const first = await arm(family.familyId, family.parentUserId);
    const second = await arm(family.familyId, family.parentUserId);
    expect(first).toEqual({ status: 'armed', spotId: expect.any(String) });
    expect(second).toEqual({ status: 'already_watching' });

    const live = await db.database
      .select({ id: schema.watchedSpots.id })
      .from(schema.watchedSpots)
      .where(eq(schema.watchedSpots.familyId, family.familyId));
    expect(live).toHaveLength(1);

    if (first.status !== 'armed') throw new Error('unreachable: the first arm was refused');
    await releaseWatchedSpot(db.database, { spotId: first.spotId, reason: 'expired', now: NOW });

    const rearmed = await arm(family.familyId, family.parentUserId);
    expect(rearmed.status).toBe('armed');
    if (rearmed.status !== 'armed') throw new Error('unreachable: the re-arm was refused');
    expect(rearmed.spotId).not.toBe(first.spotId);
  });

  /** Rule #6 and rule #1 in one: the arm is on the trail, and what it puts there is
   * provenance — never the label a parent typed, never the page they pasted. Catches an
   * audit payload widened to `{ ...intent }`. */
  it('leaves an audit row carrying the watch and its host, and neither the label nor the url', async () => {
    const family = await seedFamily(db.database, 'Audit Family');
    const armed = await arm(family.familyId, family.parentUserId, { instant: true });
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    const [row] = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, family.familyId),
          eq(schema.auditLog.actionTaken, 'watched_spot_armed'),
        ),
      );
    expect(row?.actor).toBe('system');
    expect(row?.after).toEqual({
      watchedSpotId: armed.spotId,
      host: 'cityofmarkham.perfectmind.com',
      instant: true,
    });
  });

  /** A promise the parent was told about that nothing recorded is the defect rule #11
   * exists for — so "told but not watching" is a countable audit row, not a console line.
   * Catches an arm that returns a bare null on the no-ledger-row path. */
  it('refuses to arm against a message that never went out, and says so on the trail', async () => {
    const family = await seedFamily(db.database, 'No Ledger Family');
    const outcome = await arm(family.familyId, family.parentUserId, {}, null);
    expect(outcome).toEqual({ status: 'not_armed', reason: 'no_ledger_row' });

    const spots = await db.database
      .select({ id: schema.watchedSpots.id })
      .from(schema.watchedSpots)
      .where(eq(schema.watchedSpots.familyId, family.familyId));
    expect(spots).toHaveLength(0);

    const [failure] = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, family.familyId),
          eq(schema.auditLog.actionTaken, 'watched_spot_arm_failed'),
        ),
      );
    expect(failure?.after).toEqual({
      reason: 'no_ledger_row',
      host: 'cityofmarkham.perfectmind.com',
    });
  });
});

describe('claimOpenTransition', () => {
  /** Catches dropping `AND pending_kind IS NULL AND last_state = $prev` from the guarded
   * UPDATE: the second claim would then return 2, and one opening would be two texts. */
  it('claims a transition exactly once under a double tick', async () => {
    const family = await seedFamily(db.database, 'Transition Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    const claim = { spotId: armed.spotId, from: 'full', to: 'open', kind: 'seat_opened' } as const;
    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBe(1);
    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBeNull();

    const spot = await loadSpotById(db.database, armed.spotId);
    expect(spot?.openTransitions).toBe(1);
    expect(spot?.pendingKind).toBe('seat_opened');
    expect(spot?.pendingSince).toEqual(NOW);
    expect(spot?.lastState).toBe('open');
  });
});

describe('claimSendAttempt', () => {
  /** Catches an unbounded counter (a page that keeps failing to deliver would text
   * forever) and a counter the transition claim forgets to reset (a second opening would
   * be unsendable). */
  it('spends at most two send attempts per transition, and a new transition buys two more', async () => {
    const family = await seedFamily(db.database, 'Attempt Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');
    const spotId = armed.spotId;

    await claimOpenTransition(db.database, {
      spotId,
      from: 'full',
      to: 'open',
      kind: 'seat_opened',
      now: NOW,
    });
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBe(1);
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBe(2);
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBeNull();

    // The page filled again before the send: the held observation is dropped, which is
    // what makes the class claimable a second time.
    await closeBeforeSend(db.database, { spotId, lastState: 'full', now: NOW });
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBeNull();

    expect(
      await claimOpenTransition(db.database, {
        spotId,
        from: 'full',
        to: 'open',
        kind: 'seat_opened',
        now: NOW,
      }),
    ).toBe(2);
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBe(1);
  });
});

describe('loadDueSpots', () => {
  /** The sweep's working set is bounded and ordered IN SQL, which a store fake cannot
   * prove. Catches a missing `released_at IS NULL`, a missing `next_poll_at <= now`, and
   * an ORDER BY that does not put the longest-waiting spot first. */
  it('returns only the live spots that are due, soonest first, bounded by the limit', async () => {
    const family = await seedFamily(db.database, 'Due Family');
    const armedIds: string[] = [];
    for (const minute of [30, 10, 20]) {
      const armed = await arm(family.familyId, family.parentUserId, {
        url: `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=due-${minute}`,
      });
      if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');
      armedIds.push(armed.spotId);
      await db.database
        .update(schema.watchedSpots)
        .set({ nextPollAt: new Date(NOW.getTime() - minute * 60_000) })
        .where(eq(schema.watchedSpots.id, armed.spotId));
    }
    const [due30, due10, due20] = armedIds;

    // A fourth spot, live but not due until tomorrow, and a fifth that was released.
    const notYet = await arm(family.familyId, family.parentUserId, {
      url: 'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=not-yet',
    });
    if (notYet.status !== 'armed') throw new Error('unreachable: the arm was refused');
    await db.database
      .update(schema.watchedSpots)
      .set({ nextPollAt: new Date(NOW.getTime() + 86_400_000) })
      .where(eq(schema.watchedSpots.id, notYet.spotId));
    const released = await arm(family.familyId, family.parentUserId, {
      url: 'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=released',
    });
    if (released.status !== 'armed') throw new Error('unreachable: the arm was refused');
    await releaseWatchedSpot(db.database, {
      spotId: released.spotId,
      reason: 'parent_stopped',
      now: NOW,
    });

    const due = await loadDueSpots(db.database, NOW, 10);
    expect(due.map((spot) => spot.id)).toEqual([due30, due20, due10]);
    expect(due[0]?.familyId).toBe(family.familyId);
    expect(due[0]?.sourceUrl).toContain('courseId=due-30');

    const bounded = await loadDueSpots(db.database, NOW, 2);
    expect(bounded.map((spot) => spot.id)).toEqual([due30, due20]);
  });
});

describe('the constraints themselves', () => {
  /** The half-states the sweep's own logic reads as something else: a release with no
   * reason is a watch quietly deleted, a held observation with no clock cannot be aged
   * out, and a confirmed notification of an opening that never happened is a lie the
   * Radar would count. Catches dropping any of the four CHECKs from 0109. */
  it('the database refuses the half-states, and admits a well-formed release', async () => {
    const family = await seedFamily(db.database, 'Constraint Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');
    const id = armed.spotId;

    await expect(
      db.exec(`UPDATE watched_spots SET notified_transitions = open_transitions + 1 WHERE id = '${id}'`),
    ).rejects.toThrow(/watched_spots_notify_check/);
    await expect(
      db.exec(`UPDATE watched_spots SET released_at = now() WHERE id = '${id}'`),
    ).rejects.toThrow(/watched_spots_release_check/);
    await expect(
      db.exec(
        `UPDATE watched_spots SET released_at = now(), released_reason = 'gone' WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/watched_spots_release_check/);
    await expect(
      db.exec(`UPDATE watched_spots SET pending_kind = 'seat_opened' WHERE id = '${id}'`),
    ).rejects.toThrow(/watched_spots_pending_check/);
    await expect(
      db.exec(`UPDATE watched_spots SET last_state = 'unreadable' WHERE id = '${id}'`),
    ).rejects.toThrow(/watched_spots_state_check/);

    // The positive control: the shape the sweep actually writes when a text lands.
    await db.exec(
      `UPDATE watched_spots SET notified_transitions = open_transitions, released_at = now(), released_reason = 'notified' WHERE id = '${id}'`,
    );
    const spot = await loadSpotById(db.database, id);
    expect(spot).toBeNull();
  });

  /** Rule #1: erasure is the FK cascade and nothing else — runDeletionSweep issues one
   * DELETE FROM families. Catches a family_id without ON DELETE cascade. */
  it('deleting the family erases its watched spots', async () => {
    const family = await seedFamily(db.database, 'Erasure Family');
    const armed = await arm(family.familyId, family.parentUserId);
    expect(armed.status).toBe('armed');

    await db.exec(`DELETE FROM families WHERE id = '${family.familyId}'`);

    const rows = await db.database
      .select({ id: schema.watchedSpots.id })
      .from(schema.watchedSpots)
      .where(eq(schema.watchedSpots.familyId, family.familyId));
    expect(rows).toHaveLength(0);
  });
});

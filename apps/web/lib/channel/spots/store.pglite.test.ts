import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import {
  armWatchedSpot,
  claimOpenTransition,
  claimSendAttempt,
  clearFailedAttempt,
  closeBeforeSend,
  findLedgerRowByDedupeKey,
  loadDueSpots,
  markNotifiedAndRelease,
  readLedgerStatus,
  recordPoll,
  releaseWatchedSpot,
  setNotifiedMessage,
  type SpotWatchIntent,
  type WatchedSpotArmOutcome,
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

/** The lifecycle columns of one watch, read STRAIGHT off the table: every assertion below
 * is about what a writer moved, and a reader with its own WHERE clause could hide half of
 * that behind a row it declined to return. */
async function readSpot(spotId: string) {
  const [row] = await db.database
    .select({
      lastState: schema.watchedSpots.lastState,
      pendingKind: schema.watchedSpots.pendingKind,
      pendingSince: schema.watchedSpots.pendingSince,
      openTransitions: schema.watchedSpots.openTransitions,
      notifiedTransitions: schema.watchedSpots.notifiedTransitions,
      nextPollAt: schema.watchedSpots.nextPollAt,
      releasedAt: schema.watchedSpots.releasedAt,
      releasedReason: schema.watchedSpots.releasedReason,
    })
    .from(schema.watchedSpots)
    .where(eq(schema.watchedSpots.id, spotId));
  return row ?? null;
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

    // The ending is written ONCE. A later sweep step arriving at an already-released watch
    // must not re-file why it ended — a 'notified' rewritten as a later 'expired' is the
    // misreported ending the release CHECK exists to forbid. Catches dropping
    // `AND released_at IS NULL` from releaseWatchedSpot.
    await releaseWatchedSpot(db.database, {
      spotId: first.spotId,
      reason: 'parent_stopped',
      now: new Date(NOW.getTime() + 60_000),
    });
    const releasedOnce = await readSpot(first.spotId);
    expect(releasedOnce?.releasedReason).toBe('expired');
    expect(releasedOnce?.releasedAt).toEqual(NOW);

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

  /** Once the insert lands the watch EXISTS: it will be polled and it can text, and no
   * later write can unmake it. So a bookkeeping failure after it must not come back as
   * `not_armed` — the Radar's failed-arm count would then be counting a phone that is
   * about to be texted, which is exactly the number rule #11 exists to keep honest.
   * Catches a try that wraps the trail write together with the claim. */
  it('stays armed when the trail write fails, and does not report a watch that exists as not armed', async () => {
    const family = await seedFamily(db.database, 'Trail Outage Family');

    await db.exec('ALTER TABLE audit_log RENAME TO audit_log_unavailable');
    let outcome: WatchedSpotArmOutcome;
    try {
      outcome = await arm(family.familyId, family.parentUserId);
    } finally {
      await db.exec('ALTER TABLE audit_log_unavailable RENAME TO audit_log');
    }

    expect(outcome).toEqual({ status: 'armed', spotId: expect.any(String) });
    const live = await db.database
      .select({ id: schema.watchedSpots.id })
      .from(schema.watchedSpots)
      .where(eq(schema.watchedSpots.familyId, family.familyId));
    expect(live).toHaveLength(1);
  });

  /** Rule #1 reaches the log line too. A driver error carries the failing statement, its
   * parameters and — on a constraint violation — a `detail` reading "Failing row contains
   * (…)", so logging the raw error on this path puts the label a parent typed and the page
   * they pasted into the console. Catches `console.error({ err, … })`. */
  it('names the fault and never the row when the claim itself fails', async () => {
    const family = await seedFamily(db.database, 'Write Failure Family');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await db.exec('ALTER TABLE watched_spots RENAME TO watched_spots_unavailable');
    let outcome: WatchedSpotArmOutcome;
    try {
      outcome = await arm(family.familyId, family.parentUserId);
    } finally {
      await db.exec('ALTER TABLE watched_spots_unavailable RENAME TO watched_spots');
    }

    expect(outcome).toEqual({ status: 'not_armed', reason: 'write_failed' });
    const payload = logged.mock.calls[0]?.[0];
    logged.mockRestore();

    // The whole object, so an added field cannot smuggle the row back in, and a real
    // Postgres code so the three absences below are read off a payload that exists.
    expect(payload).toEqual({
      fault: { name: 'error', code: '42P01', constraint: null },
      familyId: family.familyId,
      host: 'cityofmarkham.perfectmind.com',
    });
    expect(JSON.stringify(payload)).not.toContain('Milliken preschool swim');
    expect(JSON.stringify(payload)).not.toContain('CoursesLandingPage');
    // Not the driver's own words either: that is the field a driver fills with the
    // failing statement's parameters, and here those are the label and the page.
    expect(JSON.stringify(payload)).not.toContain('does not exist');
  });
});

describe('claimOpenTransition', () => {
  /** The double tick, which both halves of the guard reject together: the second claim
   * would return 2, and one opening would be two texts. */
  it('claims a transition exactly once under a double tick', async () => {
    const family = await seedFamily(db.database, 'Transition Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    const claim = { spotId: armed.spotId, from: 'full', to: 'open', kind: 'seat_opened' } as const;
    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBe(1);
    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBeNull();

    const spot = await readSpot(armed.spotId);
    expect(spot?.openTransitions).toBe(1);
    expect(spot?.pendingKind).toBe('seat_opened');
    expect(spot?.pendingSince).toEqual(NOW);
    expect(spot?.lastState).toBe('open');
  });

  /** The half of the guard the double tick does not test on its own. Hale is holding a
   * reopened waitlist it has not been allowed to say yet, and the page then opens a seat:
   * the second observation is a TRUE reading of the current state, so `last_state = $prev`
   * admits it — only `pending_kind IS NULL` refuses. Without it the held observation would
   * be overwritten and the parent would hear about the seat and never about the waitlist.
   * Catches dropping `AND pending_kind IS NULL`. */
  it('refuses a claim while an observation is still held, even from the current state', async () => {
    const family = await seedFamily(db.database, 'Held Observation Family');
    const armed = await arm(family.familyId, family.parentUserId, { lastState: 'waitlist_full' });
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    expect(
      await claimOpenTransition(db.database, {
        spotId: armed.spotId,
        from: 'waitlist_full',
        to: 'full',
        kind: 'waitlist_reopened',
        now: NOW,
      }),
    ).toBe(1);
    expect(
      await claimOpenTransition(db.database, {
        spotId: armed.spotId,
        from: 'full',
        to: 'open',
        kind: 'seat_opened',
        now: NOW,
      }),
    ).toBeNull();

    const spot = await readSpot(armed.spotId);
    expect(spot?.pendingKind).toBe('waitlist_reopened');
    expect(spot?.openTransitions).toBe(1);
  });

  /** The other half. Nothing is held — the observation was dropped when the page filled
   * again — but the tick that arrives is carrying a belief the row has already moved past,
   * so its `from` is stale. Only `last_state = $prev` refuses it; a claim admitted here
   * would text a parent about a seat on the strength of a reading two ticks old.
   * Catches dropping `AND last_state = $prev`. */
  it('refuses a claim carrying a stale belief, with nothing held', async () => {
    const family = await seedFamily(db.database, 'Stale Belief Family');
    const armed = await arm(family.familyId, family.parentUserId, { lastState: 'waitlist_full' });
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    await recordPoll(db.database, {
      spotId: armed.spotId,
      lastState: 'full',
      consecutiveFailures: 0,
      nextPollAt: null,
      now: NOW,
    });
    expect(
      await claimOpenTransition(db.database, {
        spotId: armed.spotId,
        from: 'waitlist_full',
        to: 'open',
        kind: 'seat_opened',
        now: NOW,
      }),
    ).toBeNull();

    const spot = await readSpot(armed.spotId);
    expect(spot?.pendingKind).toBeNull();
    expect(spot?.openTransitions).toBe(0);
    expect(spot?.lastState).toBe('full');
  });
});

describe('recordPoll', () => {
  /** `next_poll_at` carries BACKOFF and nothing else. A healthy read that also pushed the
   * column would let every successful tick move its own next due time forward by however
   * long the last one took, so a sweep that fires two minutes late would quietly halve its
   * cadence and a seat could sit unannounced. Catches a writer that always sets
   * `next_poll_at`, whatever the caller passed. */
  it('leaves next_poll_at alone on a healthy read, and moves it on a backoff', async () => {
    const family = await seedFamily(db.database, 'Cadence Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');

    const before = await readSpot(armed.spotId);
    await recordPoll(db.database, {
      spotId: armed.spotId,
      lastState: 'full',
      consecutiveFailures: 0,
      nextPollAt: null,
      now: NOW,
    });
    expect((await readSpot(armed.spotId))?.nextPollAt).toEqual(before?.nextPollAt);

    const backoff = new Date(NOW.getTime() + 40 * 60_000);
    await recordPoll(db.database, {
      spotId: armed.spotId,
      lastState: null,
      consecutiveFailures: 1,
      nextPollAt: backoff,
      now: NOW,
    });
    expect((await readSpot(armed.spotId))?.nextPollAt).toEqual(backoff);
  });
});

describe('claimSendAttempt', () => {
  /** Catches an unbounded counter (a page that keeps failing to deliver would text
   * forever), a counter the transition claim forgets to reset (a second opening would be
   * unsendable), and a claim that ignores a text already awaiting its receipt — the last
   * of which is the one that would put two texts about one seat on one phone while the
   * first is still in flight. */
  it('spends at most two send attempts per transition, never while a text is awaiting its receipt, and a new transition buys two more', async () => {
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

    // The text is out and the row that will say whether it arrived is on the watch. Until
    // that receipt reads one way or the other there is nothing to retry.
    await setNotifiedMessage(db.database, { spotId, channelMessageId: 'CM-open-1', now: NOW });
    expect(await claimSendAttempt(db.database, { spotId, now: NOW })).toBeNull();

    // It came back failed and an attempt is left: the pointer to the dead message goes and
    // the held observation stays, so the second attempt is claimable.
    await clearFailedAttempt(db.database, { spotId, now: NOW });
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

describe('markNotifiedAndRelease', () => {
  /** The ending the whole watch is for, and the only one that may be filed as 'notified'.
   * The second opening is what makes the counter assignment observable: the first was
   * dropped before it could be said, so an implementation that INCREMENTS
   * `notified_transitions` would leave it at 1 against 2 openings and the Radar would
   * report a household still owed a text it has had. Catches the reason written as
   * anything else, a held observation left behind on a closed watch, and the two counters
   * drifting apart. */
  it('files the ending as notified, drops the held observation, and squares the counters', async () => {
    const family = await seedFamily(db.database, 'Notified Family');
    const armed = await arm(family.familyId, family.parentUserId);
    if (armed.status !== 'armed') throw new Error('unreachable: the arm was refused');
    const spotId = armed.spotId;
    const claim = { spotId, from: 'full', to: 'open', kind: 'seat_opened' } as const;

    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBe(1);
    await closeBeforeSend(db.database, { spotId, lastState: 'full', now: NOW });
    expect(await claimOpenTransition(db.database, { ...claim, now: NOW })).toBe(2);

    await markNotifiedAndRelease(db.database, { spotId, now: NOW });

    const spot = await readSpot(spotId);
    expect(spot?.releasedReason).toBe('notified');
    expect(spot?.releasedAt).toEqual(NOW);
    expect(spot?.pendingKind).toBeNull();
    expect(spot?.pendingSince).toBeNull();
    expect(spot?.notifiedTransitions).toBe(2);
    expect(spot?.notifiedTransitions).toBe(spot?.openTransitions);
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
    // Due by the clock, so `released_at IS NULL` is the ONLY thing that can exclude it. A
    // released spot left on its default next_poll_at would be excluded by the time
    // predicate instead, and the control would prove nothing.
    await db.database
      .update(schema.watchedSpots)
      .set({ nextPollAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(schema.watchedSpots.id, released.spotId));
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

describe('the ledger readers', () => {
  /** The two reads the release decision rests on: a text is confirmed by the ROW's status
   * and never by the carrier's accept, and an attempt whose post-send write was lost is
   * recoverable only because the dedupe key is derived. Catches either read keyed on the
   * wrong column, and a status read that answers from anything but the row as it stands
   * now. */
  it('finds an attempt by the key it was sent under, and reads that row back as the receipt rewrites it', async () => {
    const family = await seedFamily(db.database, 'Receipt Family');
    const dedupeKey = 'spot_open:11111111-1111-1111-1111-111111111111:1:1';
    const [sent] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        category: 'spot_open',
        templateKey: 'spot_open:seat_opened',
        dedupeKey,
        status: 'queued',
      })
      .returning({ id: schema.channelMessages.id });
    if (!sent) throw new Error('unreachable: the channel_messages insert returned no row');

    expect(await findLedgerRowByDedupeKey(db.database, dedupeKey)).toEqual({
      id: sent.id,
      status: 'queued',
    });
    expect(await findLedgerRowByDedupeKey(db.database, `${dedupeKey.slice(0, -1)}2`)).toBeNull();

    expect(await readLedgerStatus(db.database, sent.id)).toBe('queued');
    await db.database
      .update(schema.channelMessages)
      .set({ status: 'failed' })
      .where(eq(schema.channelMessages.id, sent.id));
    expect(await readLedgerStatus(db.database, sent.id)).toBe('failed');
    // The status rides WITH the row because the sweep's heal decision turns on it: a
    // key can be spent by an attempt the carrier already threw away.
    expect(await findLedgerRowByDedupeKey(db.database, dedupeKey)).toEqual({
      id: sent.id,
      status: 'failed',
    });
    expect(await readLedgerStatus(db.database, '99999999-9999-9999-9999-999999999999')).toBeNull();
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
    const spot = await readSpot(id);
    expect(spot?.releasedReason).toBe('notified');
    expect(spot?.releasedAt).not.toBeNull();
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

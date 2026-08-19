import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRATION_VERIFY_ROUTE } from '~/lib/registration/verify-sweep';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { aggregateMedicalAnswers, aggregateRadarVerification } from './health-digest';

/**
 * The two founder-scorecard reads that had nothing to read until the writers below
 * started leaving a row behind — against a REAL Postgres (pglite + the production
 * migrations), because what is under test IS the SQL: a window predicate that must span
 * the sweep's Monday-aligned week, and a filter that must count a reply Hale sent rather
 * than a text a parent sent.
 *
 * A hand-rolled Drizzle fake cannot fail either of those — it returns whatever rows it
 * was handed no matter what the WHERE says — so a green suite over one would have proved
 * only that the functions were called.
 */

/** The digest runs Monday 14:00 UTC over the preceding 7 days. */
const WINDOW_END = new Date('2026-08-10T14:00:00Z');
const WINDOW_START = new Date('2026-08-03T14:00:00Z');
/** The sweep it reports on: LAST Monday's, whose claim + run rows are stamped with a
 * week start that falls just BEFORE this window opens. */
const SWEPT_WEEK = new Date('2026-08-03T00:00:00Z');

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

async function claimSweptWeek(weekStart = SWEPT_WEEK): Promise<void> {
  await db.database
    .insert(schema.rateLimits)
    .values({ identifier: 'weekly-sweep', route: REGISTRATION_VERIFY_ROUTE, windowStart: weekStart, count: 1 });
}

describe('aggregateRadarVerification — the sweep\'s own tally, not an inference', () => {
  it('reads back the split the run recorded', async () => {
    await claimSweptWeek();
    await db.database.insert(schema.registrationVerifyRuns).values({
      weekStart: SWEPT_WEEK,
      checked: 20,
      confirmed: 17,
      discrepancies: 1,
      unverified: 2,
    });

    const radar = await aggregateRadarVerification(db.database, WINDOW_START, WINDOW_END);

    expect(radar.sweptThisWeek).toBe(true);
    expect(radar.outcomes).toEqual({
      checked: 20,
      confirmed: 17,
      discrepancies: 1,
      unverified: 2,
    });
  });

  /** A week claimed and then left with no tally — the sweep died mid-run, or it ran
   * before the ledger existed. Distinct from "did not run", and the scorecard grades
   * neither. */
  it('reports a claimed week with no recorded run as swept with no outcomes', async () => {
    await claimSweptWeek();

    const radar = await aggregateRadarVerification(db.database, WINDOW_START, WINDOW_END);

    expect(radar.sweptThisWeek).toBe(true);
    expect(radar.outcomes).toBeNull();
  });

  it('sees neither a claim nor a run in a week nothing swept', async () => {
    const radar = await aggregateRadarVerification(db.database, WINDOW_START, WINDOW_END);

    expect(radar.sweptThisWeek).toBe(false);
    expect(radar.outcomes).toBeNull();
  });

  /** The predicate spans two Mondays (a week claimed before the window opens is the one
   * this digest reports on), so it can match more than one run. The LATEST is this
   * week's news; the older row is last week's, already reported. */
  it('takes the most recent run when two fall inside the predicate', async () => {
    await claimSweptWeek();
    for (const [weekStart, checked] of [
      [new Date('2026-07-27T12:00:00Z'), 9],
      [SWEPT_WEEK, 20],
    ] as const) {
      await db.database.insert(schema.registrationVerifyRuns).values({
        weekStart,
        checked,
        confirmed: checked,
        discrepancies: 0,
        unverified: 0,
      });
    }

    const radar = await aggregateRadarVerification(db.database, WINDOW_START, WINDOW_END);

    expect(radar.outcomes?.checked).toBe(20);
  });
});

describe('aggregateMedicalAnswers — what the medical lane actually sent', () => {
  async function medicalReply(
    familyId: string,
    parentUserId: string,
    source: 'web_grounded' | 'fixed',
    createdAt: Date,
  ): Promise<void> {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      body: null,
      medicalReplySource: source,
      createdAt,
    });
  }

  it('counts the answers in the window and the ones that fell back', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const inWindow = new Date('2026-08-05T18:00:00Z');
    await medicalReply(familyId, parentUserId, 'web_grounded', inWindow);
    await medicalReply(familyId, parentUserId, 'web_grounded', inWindow);
    await medicalReply(familyId, parentUserId, 'fixed', inWindow);

    const medical = await aggregateMedicalAnswers(db.database, WINDOW_START, WINDOW_END);

    expect(medical).toEqual({ answered: 3, fallbacks: 1 });
  });

  it('leaves out replies from other weeks', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await medicalReply(familyId, parentUserId, 'fixed', new Date('2026-07-28T18:00:00Z'));
    await medicalReply(familyId, parentUserId, 'fixed', new Date('2026-08-05T18:00:00Z'));

    const medical = await aggregateMedicalAnswers(db.database, WINDOW_START, WINDOW_END);

    expect(medical).toEqual({ answered: 1, fallbacks: 1 });
  });

  /**
   * A parent's own text is not one of Hale's answers. The column is written on exactly
   * one outbound path today, and the filter is what keeps a future inbound stamp from
   * doubling a SAFETY count — the one row that must never be flattered by a miscount.
   */
  it('ignores everything that is not an outbound reply carrying an outcome', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const at = new Date('2026-08-05T18:00:00Z');
    await medicalReply(familyId, parentUserId, 'web_grounded', at);
    await db.database.insert(schema.channelMessages).values([
      {
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'her fever is back',
        medicalReplySource: 'fixed',
        createdAt: at,
      },
      {
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        body: null,
        createdAt: at,
      },
    ]);

    const medical = await aggregateMedicalAnswers(db.database, WINDOW_START, WINDOW_END);

    expect(medical).toEqual({ answered: 1, fallbacks: 0 });
  });

  it('a week with no medical text reads as zero answers, not as an error', async () => {
    const medical = await aggregateMedicalAnswers(db.database, WINDOW_START, WINDOW_END);

    expect(medical).toEqual({ answered: 0, fallbacks: 0 });
  });
});

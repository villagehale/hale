import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptString } from '~/lib/crypto/string-cipher';
import { REGISTRATION_VERIFY_ROUTE } from '~/lib/registration/verify-sweep';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  aggregateMedicalAnswers,
  aggregateRadarVerification,
  aggregateW4Retention,
} from './health-digest';
import { METRICS_EXCLUDED_FAMILIES_ENV } from './metrics-scope';

/**
 * The founder-scorecard reads that had nothing to read until the writers below started
 * leaving a row behind — against a REAL Postgres (pglite + the production migrations),
 * because what is under test IS the SQL: a window predicate that must span the sweep's
 * Monday-aligned week, a filter that must count a reply Hale sent rather than a text a
 * parent sent, and a cohort grid whose whole correctness is in its WHERE.
 *
 * A hand-rolled Drizzle fake cannot fail any of those — it returns whatever rows it was
 * handed no matter what the WHERE says — so a green suite over one would have proved
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

/**
 * VIL-295 · W4 retention. Every one of these assertions is about a WHERE clause, which
 * is the whole reason they run against real Postgres: the observability cut, the two
 * message predicates and the exclusion are four lines of SQL, and each of them silently
 * changes the number when it is wrong.
 */
describe('aggregateW4Retention — the cohort grid', () => {
  /** Monday. Every provisioning date below is a whole number of weeks before it, so the
   * observable/unobservable boundary is exact rather than approximate. */
  const AS_OF = new Date('2026-08-10T14:00:00Z');
  const SIX_WEEKS_AGO = new Date('2026-06-29T14:00:00Z');
  const TWO_WEEKS_AGO = new Date('2026-07-27T14:00:00Z');
  /** Inside week 4 of a SIX_WEEKS_AGO family: [provisioned+28d, provisioned+35d). */
  const IN_WEEK_4 = new Date('2026-07-30T12:00:00Z');
  /** Inside week 3 of the same family. */
  const IN_WEEK_3 = new Date('2026-07-23T12:00:00Z');
  /** Inside week 5 of the same family. */
  const IN_WEEK_5 = new Date('2026-08-05T12:00:00Z');

  /** These four decide the answer, so no ambient value may reach the reader. */
  const OWNED_ENV = [
    METRICS_EXCLUDED_FAMILIES_ENV,
    'FOUNDER_ALERT_EMAIL',
    'WELCOME_BCC',
    'APP_ENCRYPTION_KEY',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of OWNED_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  /** A family provisioned at a chosen moment — `seedFamily` always stamps `now()`, and
   * `created_at` IS the cohort anchor. */
  async function provisioned(at: Date): Promise<{ familyId: string; parentUserId: string }> {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Test Family', provinceOrState: 'ON', createdAt: at })
      .returning({ id: schema.families.id });
    if (!family) throw new Error('provisioned: families insert returned no row');
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `${family.id}@example.test`, name: 'Test Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('provisioned: users insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: family.id, userId: user.id, role: 'primary_parent' });
    return { familyId: family.id, parentUserId: user.id };
  }

  async function message(
    family: { familyId: string; parentUserId: string },
    values: { direction: 'in' | 'out'; category: 'reply' | 'intake'; createdAt: Date },
  ): Promise<void> {
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: values.direction,
      category: values.category,
      status: values.direction === 'in' ? 'delivered' : 'sent',
      body: values.direction === 'in' ? 'still on for thursday?' : null,
      createdAt: values.createdAt,
    });
  }

  function texted(
    family: { familyId: string; parentUserId: string },
    createdAt: Date,
  ): Promise<void> {
    return message(family, { direction: 'in', category: 'reply', createdAt });
  }

  function weekOf(
    rows: Awaited<ReturnType<typeof aggregateW4Retention>>,
    weekN: number,
  ): { cohortSize: number; retained: number } {
    const row = rows.find((r) => r.weekN === weekN);
    return { cohortSize: row?.cohortSize ?? 0, retained: row?.retained ?? 0 };
  }

  /**
   * The whole grid in one assertion, because the grid's shape IS the metric: which
   * (cohort, week) cells exist at all is the observability rule, and an unelapsed week
   * must be ABSENT rather than present as a truthful-looking 0.
   */
  it('emits one row per cohort week that has fully elapsed, and none for a week that has not', async () => {
    const cameBack = await provisioned(SIX_WEEKS_AGO);
    await provisioned(SIX_WEEKS_AGO);
    await provisioned(TWO_WEEKS_AGO);
    await texted(cameBack, IN_WEEK_4);

    const rows = await aggregateW4Retention(db.database, AS_OF);

    expect(rows).toEqual([
      { signupWeek: '2026-06-29', weekN: 1, cohortSize: 2, retained: 0 },
      { signupWeek: '2026-06-29', weekN: 2, cohortSize: 2, retained: 0 },
      { signupWeek: '2026-06-29', weekN: 3, cohortSize: 2, retained: 0 },
      { signupWeek: '2026-06-29', weekN: 4, cohortSize: 2, retained: 1 },
      { signupWeek: '2026-06-29', weekN: 5, cohortSize: 2, retained: 0 },
      { signupWeek: '2026-07-27', weekN: 1, cohortSize: 1, retained: 0 },
    ]);
  });

  /**
   * THE POISONED CONTROL. The excluded family is the one that texted back, so a
   * broken exclusion does not merely fail to shrink the denominator — it invents a
   * retained family out of a QA account. Both halves are asserted: with the env set the
   * cohort is 1-of-1-none, and with the SAME rows and an empty env it is 1-of-2. A test
   * that only checked the first would pass with the WHERE clause deleted.
   */
  it('leaves an excluded family out of both the cohort and the retained count', async () => {
    const kept = await provisioned(SIX_WEEKS_AGO);
    const testAccount = await provisioned(SIX_WEEKS_AGO);
    await texted(testAccount, IN_WEEK_4);
    // Written the way a founder writes it: several ids, spaces around the commas, and
    // one id for a family that has already been erased.
    process.env[METRICS_EXCLUDED_FAMILIES_ENV] =
      `00000000-0000-0000-0000-000000000000, ${testAccount.familyId} `;

    const excludedRows = await aggregateW4Retention(db.database, AS_OF);
    expect(weekOf(excludedRows, 4)).toEqual({ cohortSize: 1, retained: 0 });
    expect(excludedRows.every((row) => row.retained === 0)).toBe(true);

    process.env[METRICS_EXCLUDED_FAMILIES_ENV] = '';
    const includedRows = await aggregateW4Retention(db.database, AS_OF);
    expect(weekOf(includedRows, 4)).toEqual({ cohortSize: 2, retained: 1 });
    expect(kept.familyId).not.toBe(testAccount.familyId);
  });

  /**
   * The founder is excluded WITHOUT being named in the env — resolved off his own
   * channel row, so there is no id to forget. Poisoned the same way: his family is the
   * only one that texted, so a missing union reads as a 100% retained cohort.
   */
  it('excludes the founder family it resolves from his own channel row, with the env empty', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const founder = await provisioned(SIX_WEEKS_AGO);
    await provisioned(SIX_WEEKS_AGO);
    await texted(founder, IN_WEEK_4);
    const [founderUser] = await db.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, founder.parentUserId));
    if (!founderUser?.email) throw new Error('founder user has no email');
    await db.database.insert(schema.parentChannels).values({
      userId: founder.parentUserId,
      familyId: founder.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString('+16135550199'),
      phoneE164Hash: 'founder-blind-index',
      verifiedAt: new Date('2026-06-29T15:00:00Z'),
    });

    process.env.FOUNDER_ALERT_EMAIL = founderUser.email;
    const rows = await aggregateW4Retention(db.database, AS_OF);
    expect(weekOf(rows, 4)).toEqual({ cohortSize: 1, retained: 0 });

    // Positive control on the resolution itself: point FOUNDER_ALERT_EMAIL at nobody
    // and the same database yields the un-excluded number.
    process.env.FOUNDER_ALERT_EMAIL = 'not-a-user@example.test';
    expect(weekOf(await aggregateW4Retention(db.database, AS_OF), 4)).toEqual({
      cohortSize: 2,
      retained: 1,
    });
  });

  /**
   * `intake` is the signup conversation, replayed into the ledger at provisioning with
   * its ORIGINAL timestamps. Counting it would retain every family in its own first
   * weeks off the back of the texts that created it. The week-3 reply is the positive
   * control: the same family, the same table, the same direction — only the category
   * differs, so a green week 3 proves the reader can see these rows at all.
   */
  it('does not count an intake text as coming back, while counting a reply from the same family', async () => {
    const family = await provisioned(SIX_WEEKS_AGO);
    await message(family, { direction: 'in', category: 'intake', createdAt: IN_WEEK_4 });
    await texted(family, IN_WEEK_3);

    const rows = await aggregateW4Retention(db.database, AS_OF);

    expect(weekOf(rows, 4)).toEqual({ cohortSize: 1, retained: 0 });
    expect(weekOf(rows, 3)).toEqual({ cohortSize: 1, retained: 1 });
  });

  /**
   * Hale's own reply is not a family coming back. Without the direction filter every
   * family Hale answered would retain itself, and the row would grade Hale's outbound
   * volume. The week-5 inbound is the positive control.
   */
  it('does not count Hale\'s outbound reply, while counting the parent\'s own', async () => {
    const family = await provisioned(SIX_WEEKS_AGO);
    await message(family, { direction: 'out', category: 'reply', createdAt: IN_WEEK_4 });
    await texted(family, IN_WEEK_5);

    const rows = await aggregateW4Retention(db.database, AS_OF);

    expect(weekOf(rows, 4)).toEqual({ cohortSize: 1, retained: 0 });
    expect(weekOf(rows, 5)).toEqual({ cohortSize: 1, retained: 1 });
  });

  it('reads an empty database as no cohorts at all, not as a zero-percent one', async () => {
    expect(await aggregateW4Retention(db.database, AS_OF)).toEqual([]);
  });
});

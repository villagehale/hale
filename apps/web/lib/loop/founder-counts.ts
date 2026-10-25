import { type Database, schema } from '@hale/db';
import {
  type SQL,
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lt,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { REGISTRATION_VERIFY_ROUTE } from '~/lib/registration/verify-sweep';
import { resolveMetricsExclusions } from './metrics-scope';
import type { MedicalAnswers, RadarVerification, RetentionCohort } from './scorecard-rubric';

/**
 * The founder counts the daily #ops post reads (VIL-437). The SQL is the same SQL the
 * retired Monday loop-health email ran.
 */

/** The founder's reporting zone — the only place a cohort LABEL is anchored to a
 * calendar. Reversible in one word: Postgres `week` is ISO, so the label is Monday-
 * aligned by construction and a different zone just moves the boundary. */
const RETENTION_TIME_ZONE = 'America/Toronto';

/** How far the grid runs. Reversible: the scorecard grades week 4, and the weeks either
 * side of it are what make that number checkable — a W4 of 0% under a W1 of 90% is a
 * churn problem, under a W1 of 0% it is a broken reader. */
const RETENTION_CURVE_WEEKS = 8;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** `notInArray` over an empty list is not a no-op on every Drizzle version. Omit it. */
function omitExcluded(column: PgColumn, ids: readonly string[] | undefined): SQL | undefined {
  if (!ids || ids.length === 0) return undefined;
  return notInArray(column, [...ids]);
}

/**
 * W4 RETENTION (VIL-295) — of the families old enough to have had a fourth week, how
 * many texted Hale back during it.
 *
 * IT REPLACED `family_active_days` ("opened the app on 3+ days in 14"). That metric was
 * true and meaningless after the pivot: the web app is the receipts room (D4/D20), so a
 * parent who never opens it and texts Hale twice a week is the SUCCESS case, and the
 * old reader scored them as churned. The signal moved to the channel, so the reader did.
 *
 * A POINT-IN-TIME read, on the `aggregateCommitmentDebt` precedent: `asOf` is a
 * horizon, not a window. Week 4 belongs to the cohort, not to the seven days the digest
 * happens to cover.
 *
 * The predicates, and what each one is holding out (all three mutation-proven — dropping
 * any of them changes the number):
 *
 *   `direction = 'in'`   — Hale's own reply is not a family coming back. Without this
 *                          every contacted family retains itself.
 *   `category = 'reply'` — the parent talking to the coach, on SMS or email. Historical
 *                          `channel:'voice'` rows from the retired ConversationRelay door
 *                          still count if one exists; nothing writes new ones.
 *                          `intake` is held out because it is the signup conversation
 *                          itself, replayed at provisioning with its original timestamps
 *                          — counting it would retain every family in its own week 0.
 *                          `caregiver` and `rsvp` are held out because the person who
 *                          sent them is not the parent: a grandmother answering an
 *                          invite and a party guest RSVPing are somebody else's evidence.
 *   the observability cut — a week is in the grid only once it has FULLY elapsed.
 *                          Otherwise a cohort provisioned on Friday reads 0% for a week
 *                          it has had two days of, and every good growth week looks like
 *                          a collapse (the `aggregateFamilyEngagement` failure mode).
 *
 * Reversible one-liners: `created_at` rather than `sent_at` because `created_at` is NOT
 * NULL and `sent_at` is nullable; `n` starts at 1 because week 0 is the intake
 * conversation; no `status` filter because inbound rows are always written `delivered`,
 * so filtering would be a second reader of a fact one column already answers.
 */
export async function aggregateW4Retention(
  database: Database,
  asOf: Date,
): Promise<RetentionCohort[]> {
  // Resolved HERE rather than passed in, so a caller cannot measure the founder's own
  // household by forgetting an argument. METRICS_EXCLUDED_FAMILY_IDS is part of that
  // set: an empty env counts the QA households.
  const excluded = await resolveMetricsExclusions(database);

  const provisionedAt = schema.families.createdAt;
  const weekN = sql`w.n`;
  /** The per-family boundary `weeks` whole weeks after provisioning. Per-family, so a
   * Wednesday signup gets a fair week 1 — reversible to a calendar-aligned boundary. */
  const afterWeeks = (weeks: SQL) => sql`${provisionedAt} + make_interval(days => 7 * (${weeks}))`;
  const signupWeek = sql<string>`(date_trunc('week', ${provisionedAt} at time zone ${RETENTION_TIME_ZONE}))::date::text`;

  const cameBack = sql`exists (select 1 from ${schema.channelMessages} where ${and(
    eq(schema.channelMessages.familyId, schema.families.id),
    eq(schema.channelMessages.direction, 'in'),
    eq(schema.channelMessages.category, 'reply'),
    gte(schema.channelMessages.createdAt, afterWeeks(weekN)),
    lt(schema.channelMessages.createdAt, afterWeeks(sql`${weekN} + 1`)),
  )})`;

  return (
    database
      .select({
        signupWeek,
        weekN: sql<number>`w.n`,
        cohortSize: sql<number>`count(*)::int`,
        retained: sql<number>`count(*) filter (where ${cameBack})::int`,
      })
      .from(
        sql`${schema.families} cross join generate_series(1, ${RETENTION_CURVE_WEEKS}::int) as w(n)`,
      )
      .where(
        and(
          omitExcluded(schema.families.id, [...excluded]),
          sql`${afterWeeks(sql`${weekN} + 1`)} <= ${asOf.toISOString()}::timestamptz`,
        ),
      )
      // Grouped by OUTPUT POSITION rather than by repeating the expression. Postgres
      // matches a GROUP BY expression to the select list structurally, and Drizzle binds
      // the timezone as a placeholder — so the repeated form is two different `$n` and
      // Postgres rejects `families.created_at` as ungrouped.
      .groupBy(sql`1`, sql`2`)
      .orderBy(sql`1`, sql`2`)
  );
}

/**
 * The radar row, read from the two rows the re-verify sweep leaves behind: the claim it
 * takes BEFORE the work ("a sweep owned this week") and the tally it writes AFTER ("this
 * is what it found"). Two questions, two rows, and the pair is what lets a sweep that
 * died mid-run read as neither a clean week nor a missing cron.
 *
 * The counts are the SWEEP'S OWN. They were inferred here once — due windows counted off
 * `registration_windows`, confirmations off the `verified_at` it bumps — and that reading
 * could never split the failures, because a moved date and an unreadable page both
 * deliberately write nothing (the sweep's honesty design). Inferring it a second way
 * beside the recorded one would just be two answers to one question.
 *
 * WHY THE WEEK IS TESTED FOR OVERLAP, NOT CONTAINMENT. The sweep claims a MONDAY-ALIGNED
 * week, and the Monday digest runs Monday 14:00 UTC — two hours BEFORE that same Monday's
 * sweep (16:00). So the sweep that digest reports on is LAST Monday's, whose rows are
 * stamped with a week start that falls just before the digest window opens. A containment
 * test would report every single week as "the sweep did not run". A claimed week
 * [monday, monday+7d) overlaps this window when its start is after windowStart − 7d and
 * before windowEnd, which is what the predicate below says — and because that spans two
 * Mondays, the tally is taken newest-first.
 *
 * Family-agnostic: the sweep's tally has no family id. A sweep that did not run is not
 * zero discrepancies.
 */
export async function aggregateRadarVerification(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<RadarVerification> {
  const sweptWeek = (column: PgColumn) =>
    and(gt(column, new Date(windowStart.getTime() - WEEK_MS)), lt(column, windowEnd));

  const [claimRow] = await database
    .select({ count: count() })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, REGISTRATION_VERIFY_ROUTE),
        sweptWeek(schema.rateLimits.windowStart),
      ),
    );

  const [run] = await database
    .select({
      checked: schema.registrationVerifyRuns.checked,
      confirmed: schema.registrationVerifyRuns.confirmed,
      discrepancies: schema.registrationVerifyRuns.discrepancies,
      unverified: schema.registrationVerifyRuns.unverified,
    })
    .from(schema.registrationVerifyRuns)
    .where(sweptWeek(schema.registrationVerifyRuns.weekStart))
    .orderBy(desc(schema.registrationVerifyRuns.weekStart))
    .limit(1);

  return {
    sweptThisWeek: (claimRow?.count ?? 0) > 0,
    outcomes: run ?? null,
  };
}

/**
 * The safety row's other half: medical-symptom texts Hale ANSWERED this week, and how
 * many of those answers were the fixed 811/911 line rather than a grounded reply.
 *
 * Read off the outbound rows the lane stamps, because that is where the outcome is a
 * fact — the inbound row is deliberately left unstamped (a question Hale answered is not
 * an unmet intent, and stamping it would corrupt the demand count). The direction filter
 * is not decoration: this number feeds the one row that must never be flattered, and a
 * parent's own text is not one of Hale's answers.
 *
 * `excludeFamilyIds` is the metrics exclusion set. Omitted, or empty, counts every
 * family — which is how an unset METRICS_EXCLUDED_FAMILY_IDS counts QA households.
 */
export async function aggregateMedicalAnswers(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
  excludeFamilyIds?: readonly string[],
): Promise<MedicalAnswers> {
  const rows = await database
    .select({ source: schema.channelMessages.medicalReplySource, count: count() })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        isNotNull(schema.channelMessages.medicalReplySource),
        gte(schema.channelMessages.createdAt, windowStart),
        lt(schema.channelMessages.createdAt, windowEnd),
        omitExcluded(schema.channelMessages.familyId, excludeFamilyIds),
      ),
    )
    .groupBy(schema.channelMessages.medicalReplySource);

  return {
    answered: rows.reduce((sum, row) => sum + row.count, 0),
    fallbacks: rows
      .filter((row) => row.source === 'fixed')
      .reduce((sum, row) => sum + row.count, 0),
  };
}

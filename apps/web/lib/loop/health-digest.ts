import { type Database, schema } from '@hale/db';
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { type CommitmentDebt, aggregateCommitmentDebt } from '~/lib/commitments/ledger';
import { LOOP_EMAIL_TYPES } from '~/lib/cron/email-compliance';
import {
  PROVIDER_INCIDENT_ROUTE,
  escalateDigestSendFailure,
  providerIncidentKind,
} from '~/lib/monitoring/provider-health';
import { REGISTRATION_VERIFY_ROUTE } from '~/lib/registration/verify-sweep';
import {
  aggregateFunnelScoreboard,
  DELIVERED_STATUSES,
  type FunnelScoreboard,
  formatFunnelScoreboard,
} from './funnel-scoreboard';
import { resolveMetricsExclusions } from './metrics-scope';
import {
  type FamilyEngagement,
  type MedicalAnswers,
  type RadarVerification,
  type RetentionCohort,
  type ScorecardRow,
  gradeActivation,
  gradeDeliverability,
  gradeDemand,
  gradeEngagement,
  gradeRadarAccuracy,
  gradeSafety,
  gradeUnitCost,
  gradeW4Retention,
} from './scorecard-rubric';

/**
 * X1 (VIL-227) · the weekly loop-health digest to the founder. Reuses the
 * founder-signal/stop-alert Resend pattern (aloha@, injectable client, best-effort)
 * rather than the parent-facing digest infra (runDigestForFamily) — this is an
 * internal ops summary, not a per-family brief, so it has no recipient/opt-out/CASL
 * concerns of its own.
 *
 * The query (aggregateLoopHealth) is thin and DB-only; the formatting
 * (formatLoopHealthDigest) is pure and unit-tested without a DB, mirroring
 * monitoring/spend.ts's summarizeSpend split.
 */

export interface MessageCountRow {
  channel: string;
  /**
   * Which way the leg went. Inbound rows are written `status: 'delivered'` — one per
   * text a parent sends — so a breakdown without this column cannot tell a delivery
   * from a reply, and the scorecard's deliverability row would count a chatty week as
   * a flawless send record.
   */
  direction: string;
  category: string;
  status: string;
  count: number;
}

/** One founder alert raised in the window (VIL-255): the incident class, and when. */
export interface ProviderIncidentRow {
  kind: string;
  at: Date;
}

/**
 * One bucket of texts Hale declined to take on this week (VIL-273).
 *
 * This is the product's demand signal: the off-domain lane is the only place Hale ever
 * says no, and what parents ask for when it does is the shortest list of what to build
 * next. The category is drawn from a closed vocabulary (see `UnmetIntentCategory`)
 * precisely so this email can only ever hold a bucket and a number — never the words a
 * parent typed, never a child (rule #1).
 */
export interface UnmetIntentRow {
  lane: string;
  category: string;
  count: number;
}

export interface LoopHealthSummary {
  windowStart: Date;
  windowEnd: Date;
  messageCounts: MessageCountRow[];
  stopCount: number;
  weekPlansComposed: number;
  providerIncidents: ProviderIncidentRow[];
  /** X1 · the F14 intake-funnel scoreboard for the same window. */
  scoreboard: FunnelScoreboard;
  /**
   * MEM-10 · what Hale has promised and not yet delivered. A POINT-IN-TIME balance, not
   * a windowed flow like everything above it: a promise made three weeks ago and still
   * unkept is exactly what a trailing-7-day count would hide.
   */
  commitmentDebt: CommitmentDebt;
  /** The scorecard's engagement row: families that had a full week in which to hear
   * from Hale, and how many did. */
  engagement: FamilyEngagement;
  /**
   * VIL-295 · the retention grid, and the other POINT-IN-TIME read on this summary: a
   * cohort's fourth week is a fact about that cohort, not about the seven days this
   * digest covers, so it is read as of `windowEnd` on the `commitmentDebt` precedent
   * rather than over `[windowStart, windowEnd)`.
   */
  w4Retention: RetentionCohort[];
  /** The scorecard's radar row: whether the weekly re-verify sweep ran, and how much
   * of the actionable dataset it re-confirmed at source. */
  radar: RadarVerification;
  /** The scorecard's other safety input: medical-symptom texts Hale answered, and how
   * many of those answers fell back to the fixed 811/911 line. */
  medicalAnswers: MedicalAnswers;
  /** VIL-273 · what parents asked for that Hale does not do, bucketed. Any order —
   * the formatter ranks it. */
  unmetIntents: UnmetIntentRow[];
}

type MessageCategory = (typeof schema.channelMessageCategoryEnum.enumValues)[number];

/**
 * The categories whose messages exist because somebody ELSE started something — a
 * parent's reply, an intake conversation they opened, a caregiver invite they sent, a
 * guest RSVPing to their party, a phone call Hale texted back. Everything else in the
 * enum is Hale making contact first, which is what the engagement row counts.
 *
 * Written as the EXCLUSIONS rather than the inclusions on purpose. A category added to
 * this enum is far likelier to be another proactive class — `nudge`, `village_intro`,
 * `followup` and `plan_check_in` all were — so the default must be to count it. An
 * inclusion list would drop the next one silently, and a silently shrinking numerator
 * reads as a loop going quiet.
 */
const PARENT_STARTED_CATEGORIES: readonly MessageCategory[] = [
  'reply',
  'intake',
  'caregiver',
  'rsvp',
  'voice',
];

const HALE_INITIATED_CATEGORIES: MessageCategory[] =
  schema.channelMessageCategoryEnum.enumValues.filter(
    (category) => !PARENT_STARTED_CATEGORIES.includes(category),
  );

/** Sums channel_messages by channel/direction/category/status, the loop_stop count
 * (email_opt_outs rows landed on a loop stream), and week_plans composed — all
 * within [windowStart, windowEnd). */
export async function aggregateLoopHealth(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<LoopHealthSummary> {
  const messageCounts = await database
    .select({
      channel: schema.channelMessages.channel,
      direction: schema.channelMessages.direction,
      category: schema.channelMessages.category,
      status: schema.channelMessages.status,
      count: count(),
    })
    .from(schema.channelMessages)
    .where(
      and(
        gte(schema.channelMessages.createdAt, windowStart),
        lt(schema.channelMessages.createdAt, windowEnd),
      ),
    )
    .groupBy(
      schema.channelMessages.channel,
      schema.channelMessages.direction,
      schema.channelMessages.category,
      schema.channelMessages.status,
    );

  const [stopRow] = await database
    .select({ count: count() })
    .from(schema.emailOptOuts)
    .where(
      and(
        gte(schema.emailOptOuts.optedOutAt, windowStart),
        lt(schema.emailOptOuts.optedOutAt, windowEnd),
        inArray(schema.emailOptOuts.emailType, [...LOOP_EMAIL_TYPES]),
      ),
    );

  const [plansRow] = await database
    .select({ count: count() })
    .from(schema.weekPlans)
    .where(and(gte(schema.weekPlans.composedAt, windowStart), lt(schema.weekPlans.composedAt, windowEnd)));

  // VIL-255: the provider incidents already claimed in this window. Read back from the
  // dedupe claims themselves, so the weekly line costs no extra probe and can only ever
  // report incidents the founder was actually paged about.
  const incidentRows = await database
    .select({
      identifier: schema.rateLimits.identifier,
      at: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, PROVIDER_INCIDENT_ROUTE),
        gte(schema.rateLimits.windowStart, windowStart),
        lt(schema.rateLimits.windowStart, windowEnd),
      ),
    );

  // VIL-273 · the deflections. Same table and same window as the message breakdown
  // above, because the signal is stamped on the inbound row itself rather than kept in
  // a ledger of its own — the partial index makes this the handful of rows that carry a
  // lane rather than a scan of the whole week's traffic.
  const unmetRows = await database
    .select({
      lane: schema.channelMessages.unmetLane,
      category: schema.channelMessages.unmetCategory,
      count: count(),
    })
    .from(schema.channelMessages)
    .where(
      and(
        isNotNull(schema.channelMessages.unmetLane),
        gte(schema.channelMessages.createdAt, windowStart),
        lt(schema.channelMessages.createdAt, windowEnd),
      ),
    )
    .groupBy(schema.channelMessages.unmetLane, schema.channelMessages.unmetCategory);

  const scoreboard = await aggregateFunnelScoreboard(database, windowStart, windowEnd);
  const engagement = await aggregateFamilyEngagement(database, windowStart, windowEnd);
  const radar = await aggregateRadarVerification(database, windowStart, windowEnd);
  const medicalAnswers = await aggregateMedicalAnswers(database, windowStart, windowEnd);

  // MEM-10 · read as of the window's END rather than over the window, because debt is a
  // balance. NEVER a send: this sweep's whole job is that the debt is VISIBLE to the
  // founder, and texting a family "sorry, I still owe you" is a send-policy decision
  // nobody has made yet.
  const commitmentDebt = await aggregateCommitmentDebt(database, windowEnd);
  // VIL-295 · same reasoning, same seam: retention is a balance too.
  const w4Retention = await aggregateW4Retention(database, windowEnd);

  return {
    windowStart,
    windowEnd,
    messageCounts,
    stopCount: stopRow?.count ?? 0,
    weekPlansComposed: plansRow?.count ?? 0,
    providerIncidents: incidentRows.map((row) => ({
      kind: providerIncidentKind(row.identifier),
      at: row.at,
    })),
    scoreboard,
    commitmentDebt,
    engagement,
    w4Retention,
    radar,
    medicalAnswers,
    // The check constraint makes a half-stamped row unwritable, so a lane implies a
    // category; the coalesce is a type narrowing, not a guess about missing data.
    unmetIntents: unmetRows.map((row) => ({
      lane: row.lane ?? 'unknown',
      category: row.category ?? 'unknown',
      count: row.count,
    })),
  };
}

/**
 * The engagement row's two numbers.
 *
 * THE DENOMINATOR IS FAMILIES THAT EXISTED FOR THE WHOLE WINDOW. A family that signed
 * up on Saturday had a day, not a week, and counting it would make every good growth
 * week read as a quiet loop — the metric would punish exactly the thing it wants. The
 * same predicate is applied to the numerator's join, so the ratio can never exceed 1.
 *
 * The numerator counts legs that LEFT (see DELIVERED_STATUSES): a nudge suppressed by
 * quiet hours is not contact, however good the intention behind it was.
 */
export async function aggregateFamilyEngagement(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<FamilyEngagement> {
  const establishedBeforeWindow = lt(schema.families.createdAt, windowStart);

  const [familiesRow] = await database
    .select({ count: count() })
    .from(schema.families)
    .where(establishedBeforeWindow);

  const [contactedRow] = await database
    .select({ count: countDistinct(schema.channelMessages.familyId) })
    .from(schema.channelMessages)
    .innerJoin(schema.families, eq(schema.families.id, schema.channelMessages.familyId))
    .where(
      and(
        establishedBeforeWindow,
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.category, HALE_INITIATED_CATEGORIES),
        inArray(schema.channelMessages.status, [...DELIVERED_STATUSES]),
        gte(schema.channelMessages.createdAt, windowStart),
        lt(schema.channelMessages.createdAt, windowEnd),
      ),
    );

  return { families: familiesRow?.count ?? 0, contacted: contactedRow?.count ?? 0 };
}

/** The founder's reporting zone — the only place a cohort LABEL is anchored to a
 * calendar. Reversible in one word: Postgres `week` is ISO, so the label is Monday-
 * aligned by construction and a different zone just moves the boundary. */
const RETENTION_TIME_ZONE = 'America/Toronto';

/** How far the grid runs. Reversible: the scorecard grades week 4, and the weeks either
 * side of it are what make that number checkable — a W4 of 0% under a W1 of 90% is a
 * churn problem, under a W1 of 0% it is a broken reader. */
const RETENTION_CURVE_WEEKS = 8;

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
 *   `category = 'reply'` — the parent talking to the coach, on ANY channel: SMS, email,
 *                          and a phone call (voice turns are written `channel:'voice',
 *                          category:'reply'` — see channel/twilio/voice-record.ts), so a
 *                          family whose whole week-4 contact was a call does count.
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
  // household by forgetting an argument.
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

  return database
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
        notInArray(schema.families.id, [...excluded]),
        sql`${afterWeeks(sql`${weekN} + 1`)} <= ${asOf.toISOString()}::timestamptz`,
      ),
    )
    // Grouped by OUTPUT POSITION rather than by repeating the expression. Postgres
    // matches a GROUP BY expression to the select list structurally, and Drizzle binds
    // the timezone as a placeholder — so the repeated form is two different `$n` and
    // Postgres rejects `families.created_at` as ungrouped.
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`, sql`2`);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
 * week, and this digest runs Monday 14:00 UTC — two hours BEFORE that same Monday's sweep
 * (16:00). So the sweep this digest reports on is LAST Monday's, whose rows are stamped
 * with a week start that falls just before the digest window opens. A containment test
 * would report every single week as "the sweep did not run". A claimed week
 * [monday, monday+7d) overlaps this window when its start is after windowStart − 7d and
 * before windowEnd, which is what the predicate below says — and because that spans two
 * Mondays, the tally is taken newest-first.
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
 */
export async function aggregateMedicalAnswers(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * VIL-255 · the one-line provider status. Counts the week's founder-paged incidents by
 * class rather than probing live: a weekly report's honest subject is what happened
 * over the week, and a green probe on Monday morning would say nothing about the
 * Wednesday the briefs did not send.
 */
function providerHealthLine(incidents: ProviderIncidentRow[]): string {
  const [first, ...rest] = incidents;
  if (!first) {
    return 'LLM provider: no incidents';
  }
  const byKind = new Map<string, number>();
  for (const incident of incidents) {
    byKind.set(incident.kind, (byKind.get(incident.kind) ?? 0) + 1);
  }
  const breakdown = [...byKind]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${kind} ×${n}`)
    .join(', ');
  const last = rest.reduce((latest, i) => (i.at > latest ? i.at : latest), first.at);
  return `LLM provider: ${incidents.length} incidents — ${breakdown} (last ${isoDate(last)})`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * MEM-10 · the one line that says whether Hale is keeping its word.
 *
 * Counted in FAMILIES, because that is the unit of the harm: one household owed two
 * things is one household let down, and a promise count alone would make a single
 * unlucky family read as an outage. The promise count rides along in the parenthesis so
 * the shape of the debt is still visible.
 *
 * Three states, not two. "0 overdue" over an empty ledger and "0 overdue" over nine live
 * promises are the same number and completely different news — a ledger nothing writes
 * to is a broken wiring report, and it must not read as a clean week.
 */
function openLoopsLine(debt: CommitmentDebt): string {
  if (debt.openCommitments === 0) {
    return 'Open loops: nothing recorded yet - the ledger is empty';
  }
  if (debt.overdueCommitments === 0) {
    return `Open loops: none overdue - ${debt.openCommitments} open and still in time`;
  }
  return `Open loops: Hale owes ${plural(debt.overdueFamilies, 'family', 'families')} something overdue (${plural(debt.overdueCommitments, 'promise', 'promises')} past due, ${debt.openCommitments} open)`;
}

/**
 * The eight graded rows, each fed the slice of the week it grades and nothing else.
 *
 * The order is the loop's own: a family is found (demand), answered (activation),
 * looked after (engagement), comes back (W4 retention), told the truth (radar
 * accuracy), actually reached (deliverability), kept safe (safety), and paid for
 * (unit cost). Read top to bottom it is the product's whole causal chain, so the first
 * row that drops is usually the one the others are downstream of.
 *
 * Retention sits directly under engagement because the two are one question asked from
 * both ends — whether Hale reached them, then whether they came back.
 */
export function buildScorecard(summary: LoopHealthSummary): ScorecardRow[] {
  const { intake, ttfa, cogs } = summary.scoreboard;
  return [
    gradeDemand(intake),
    gradeActivation({
      p50Seconds: ttfa.p50Seconds,
      provisioned: intake.provisioned,
      sessionsStarted: intake.sessionsStarted,
    }),
    gradeEngagement(summary.engagement),
    gradeW4Retention(summary.w4Retention),
    gradeRadarAccuracy(summary.radar),
    gradeDeliverability(summary.messageCounts),
    gradeSafety(summary.unmetIntents, summary.medicalAnswers),
    gradeUnitCost(cogs),
  ];
}

/** Widest label ('Deliverability', 'Radar accuracy') plus two spaces, so every score
 * lands in one column and a two-digit 10 never runs into the label it grades. */
const SCORECARD_LABEL_WIDTH = 16;

/** An ungradeable row. A dash, never a 0 — the two are opposite claims. */
const NO_GRADE = '–';

function scorecardLines(rows: ScorecardRow[]): string[] {
  return rows.map((row) => {
    const score = (row.score === null ? NO_GRADE : String(row.score)).padStart(2);
    return `  ${row.label.padEnd(SCORECARD_LABEL_WIDTH)}${score}/10 · ${row.reason}`;
  });
}

/** Plain-text founder digest body. Pure — no DB, no network — so the format is
 * unit-tested against worked summaries. Counts only (rule #1): no family/child/
 * parent identifying detail ever enters this text. */
export function formatLoopHealthDigest(summary: LoopHealthSummary): string {
  const lines: string[] = [
    `Hale · loop health · ${isoDate(summary.windowStart)} – ${isoDate(summary.windowEnd)}`,
    '',
    // The scorecard leads. Everything below it is the evidence for these eight
    // judgements, not a second set of things to interpret.
    'SCORECARD · every threshold is a named constant in lib/loop/scorecard-rubric.ts',
    ...scorecardLines(buildScorecard(summary)),
    '',
    `Weekly plans composed: ${summary.weekPlansComposed}`,
    `STOPs (loop unsubscribes): ${summary.stopCount}`,
    openLoopsLine(summary.commitmentDebt),
    providerHealthLine(summary.providerIncidents),
    '',
    ...formatFunnelScoreboard(summary.scoreboard),
    '',
    'Top unmet intents (7d):',
  ];
  // Ranked, then alphabetical so a tie does not reshuffle week to week. An empty week
  // here is a real measurement (nothing was deflected), not missing data — so the line
  // says which of the two it is rather than leaving a founder to wonder whether the
  // lane is even live.
  if (summary.unmetIntents.length === 0) {
    lines.push('  (none - no text was deflected this week)');
  } else {
    const ranked = [...summary.unmetIntents].sort(
      (a, b) => b.count - a.count || `${a.lane}${a.category}`.localeCompare(`${b.lane}${b.category}`),
    );
    for (const row of ranked) {
      lines.push(`  ${row.lane} · ${row.category}: ${row.count}`);
    }
  }
  lines.push('', 'Messages by channel / category / status:');
  if (summary.messageCounts.length === 0) {
    lines.push('  (none)');
  } else {
    for (const row of summary.messageCounts) {
      lines.push(
        `  ${row.channel} · ${row.direction} · ${row.category} · ${row.status}: ${row.count}`,
      );
    }
  }
  return lines.join('\n');
}

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

/** Whether the provider took the send — and when it did not, WHY, by name (rule #11,
 * the papercut sender's exact shape): a digest with nowhere to go is a different fact
 * from a provider that refused one, and only the refusal is worth escalating. */
export type LoopHealthSendOutcome =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'provider_error' };

export interface LoopHealthDigestSender {
  send(body: string): Promise<LoopHealthSendOutcome>;
}

export function createLoopHealthDigestSender(client?: Resend): LoopHealthDigestSender {
  return {
    async send(body) {
      const to = founderAddress();
      const apiKey = process.env.RESEND_API_KEY;
      if (!to || (!apiKey && !client)) {
        return { sent: false, reason: 'not_configured' };
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await transport.send({
        from,
        to,
        subject: 'Hale · weekly loop health',
        text: body,
      });
      return error ? { sent: false, reason: 'provider_error' } : { sent: true };
    },
  };
}

/** The rolling aggregation window: the 7 days ending at `now`. An internal ops
 * report, so a simple UTC rolling window (not the family-local Mon–Sun the loop
 * itself uses) is deliberate — no per-family timezone applies to an aggregate. */
const DIGEST_WINDOW_DAYS = 7;

export interface LoopHealthDigestDeps {
  aggregate: typeof aggregateLoopHealth;
  sender: LoopHealthDigestSender;
  /** Escalate a refused send through the ops seam (provider-health incident, deduped
   * per digest per window). Required (rule #11): this digest is a founder surface
   * whose silent death reads as a quiet week — the 2026-09-03 audit's exact finding. */
  escalate: (database: Database, reason: string) => Promise<void>;
}

export function defaultLoopHealthDigestDeps(): LoopHealthDigestDeps {
  return {
    aggregate: aggregateLoopHealth,
    sender: createLoopHealthDigestSender(),
    escalate: async (database, reason) => {
      await escalateDigestSendFailure(database, 'loop_health', reason);
    },
  };
}

/** Every way the weekly run can end, named (rule #11) — the papercut digest's exact
 * vocabulary, so the two founder digests cannot drift apart. */
export type LoopHealthDigestOutcome = 'sent' | 'send_skipped_not_configured' | 'send_failed';

export interface LoopHealthDigestResult {
  outcome: LoopHealthDigestOutcome;
  summary: LoopHealthSummary;
}

/** The weekly cron entry point: aggregate the trailing week and email the founder.
 * Un-gated by a feature flag (like founder-signal's notifySignup) — it degrades to
 * a NAMED no-op via the sender's own guards (no founder address / no Resend key)
 * rather than a separate send-enabled switch, since this never reaches a real
 * family. A provider refusal is escalated through the ops seam: the digest failing
 * to send must never be indistinguishable from a clean week. */
export async function runLoopHealthDigestCron(
  database: Database,
  deps: LoopHealthDigestDeps = defaultLoopHealthDigestDeps(),
  now: Date = new Date(),
): Promise<LoopHealthDigestResult> {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const summary = await deps.aggregate(database, windowStart, windowEnd);
  const send = await deps.sender.send(formatLoopHealthDigest(summary));
  if (send.sent) return { outcome: 'sent', summary };
  if (send.reason === 'not_configured') {
    console.error('loop health digest: no founder address/Resend key - digest composed, not sent');
    return { outcome: 'send_skipped_not_configured', summary };
  }
  console.error('loop health digest: provider refused the send');
  await deps.escalate(database, send.reason);
  return { outcome: 'send_failed', summary };
}

import { type Database, schema } from '@hale/db';
import { and, count, countDistinct, eq, gte, inArray, isNotNull, lt, sum } from 'drizzle-orm';

/**
 * X1 · the F14 intake-funnel scoreboard, carried on the founder's Monday loop-health
 * digest. The Build Plan fixes these definitions "now so the numbers are comparable
 * forever", so they live in one place and are computed from tables that already
 * exist — sms_intake_sessions, channel_messages, consent_records, agent_runs.
 *
 * It is built BEFORE the M0 cohort arrives, which makes honesty the whole design
 * constraint: every line reports "no data yet" rather than a zero that reads like a
 * measurement, and TTFA separates families it could measure from families it could
 * not. A funnel that quietly fabricates a denominator is how a launch gets misread.
 *
 * Same split as health-digest.ts / monitoring's summarizeSpend: the queries are thin
 * and DB-only, the derivations and formatting are pure and unit-tested.
 */

export interface IntakeFunnel {
  sessionsStarted: number;
  provisioned: number;
  watchConsented: number;
  /**
   * Of the sessions started, the ones that arrived carrying a QR venue code — the
   * only field in the whole intake that says WHERE a family came from. Counted apart
   * from `sessionsStarted` because attributed and unattributed demand are different
   * facts: the founder scorecard grades the probe against a weekly target, and a week
   * of walk-ins tells it nothing about which venue is working.
   */
  sourceCoded: number;
}

export interface TtfaStat {
  /** Median seconds, across the families both ends were derivable for. */
  p50Seconds: number | null;
  derivedFamilies: number;
  notDerivableFamilies: number;
}

export interface NudgeEngagement {
  sent: number;
  /** Of those, the ones sent early enough to have had a full 48h to be answered. */
  matured: number;
  replied: number;
}

export interface LlmCogs {
  totalUsd: number;
  /** Distinct families carrying a recorded cost — the per-family divisor. */
  families: number;
}

export interface FunnelScoreboard {
  intake: IntakeFunnel;
  ttfa: TtfaStat;
  nudges: NudgeEngagement;
  cogs: LlmCogs;
}

// ── TTFA ─────────────────────────────────────────────────────────────────────

export interface IntakeMessageRow {
  familyId: string;
  direction: 'in' | 'out';
  sentAt: Date | null;
  familyCreatedAt: Date;
}

const NUDGE_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * TTFA — the parent's first text to the radar reply, per family, then the median.
 *
 * The radar reply is identified as the first outbound intake message sent AT OR
 * AFTER the family row existed. That is not a guess about content: the greeting and
 * the one follow-up are sent while there is still no family (they are replayed into
 * channel_messages at provisioning, keeping their original sent_at), and the radar is
 * by construction the first thing sent once provisioning has committed. Reading
 * `created_at` instead would date every replayed row to the provisioning moment.
 *
 * A family with no post-provisioning outbound, or with a missing sent_at, is counted
 * as NOT derivable instead of being given an invented latency.
 */
export function computeTtfa(rows: IntakeMessageRow[]): TtfaStat {
  const byFamily = new Map<string, IntakeMessageRow[]>();
  for (const row of rows) {
    const existing = byFamily.get(row.familyId);
    if (existing) {
      existing.push(row);
    } else {
      byFamily.set(row.familyId, [row]);
    }
  }

  const latencies: number[] = [];
  let notDerivableFamilies = 0;
  for (const familyRows of byFamily.values()) {
    const timed = familyRows.filter(
      (row): row is IntakeMessageRow & { sentAt: Date } => row.sentAt !== null,
    );
    const firstText = earliest(timed.filter((row) => row.direction === 'in'));
    const radarReply = earliest(
      timed.filter((row) => row.direction === 'out' && row.sentAt >= row.familyCreatedAt),
    );
    if (!firstText || !radarReply || radarReply < firstText) {
      notDerivableFamilies += 1;
      continue;
    }
    latencies.push(Math.round((radarReply.getTime() - firstText.getTime()) / 1000));
  }

  return {
    p50Seconds: medianNearestRank(latencies),
    derivedFamilies: latencies.length,
    notDerivableFamilies,
  };
}

function earliest(rows: Array<{ sentAt: Date }>): Date | null {
  return rows.reduce<Date | null>(
    (min, row) => (min === null || row.sentAt < min ? row.sentAt : min),
    null,
  );
}

/** Nearest-rank p50: the value at ceil(n/2), 1-indexed. No interpolation — these are
 * observed latencies, and an averaged midpoint is a latency nobody experienced. */
function medianNearestRank(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
}

// ── nudge engagement ─────────────────────────────────────────────────────────

export interface NudgeRow {
  familyId: string;
  sentAt: Date;
}

/** Any inbound message from the family — the correlation signal for a nudge reply. */
export interface ReplyRow {
  familyId: string;
  sentAt: Date;
}

/**
 * Nudge engagement, by the simplest correlation that can be stated in one sentence:
 * a nudge counts as engaged when that family sent ANY inbound message within 48h of
 * it. There is no reply-to pointer on an SMS, so anything sharper would be a guess
 * dressed as a join.
 *
 * Two known consequences, both deliberate: an inbound about something else can credit
 * a nudge, and one reply can credit two nudges sent close together. Both inflate
 * rather than deflate, so the number is an upper bound — read it as one.
 *
 * Only MATURED nudges (sent at least 48h before the window closed) are scored, so the
 * rate is not diluted by nudges that simply have not had their chance yet, and stays
 * comparable week to week.
 */
export function computeNudgeEngagement(
  nudges: NudgeRow[],
  replies: ReplyRow[],
  windowEnd: Date,
): NudgeEngagement {
  const repliesByFamily = new Map<string, Date[]>();
  for (const reply of replies) {
    const existing = repliesByFamily.get(reply.familyId);
    if (existing) {
      existing.push(reply.sentAt);
    } else {
      repliesByFamily.set(reply.familyId, [reply.sentAt]);
    }
  }

  const matured = nudges.filter(
    (nudge) => nudge.sentAt.getTime() + NUDGE_REPLY_WINDOW_MS <= windowEnd.getTime(),
  );
  const replied = matured.filter((nudge) =>
    (repliesByFamily.get(nudge.familyId) ?? []).some(
      (at) =>
        at.getTime() > nudge.sentAt.getTime() &&
        at.getTime() <= nudge.sentAt.getTime() + NUDGE_REPLY_WINDOW_MS,
    ),
  );

  return { sent: nudges.length, matured: matured.length, replied: replied.length };
}

// ── formatting ───────────────────────────────────────────────────────────────

/** Conversion from the preceding funnel step. `n/a` when that step is empty — a rate
 * out of nothing is undefined, not zero. */
function conversion(n: number, base: number): string {
  return base === 0 ? 'n/a' : `${Math.round((n / base) * 100)}%`;
}

function intakeLine(intake: IntakeFunnel): string {
  if (intake.sessionsStarted === 0) {
    return 'Intake funnel (7d): no sessions started yet';
  }
  return [
    `Intake funnel (7d): ${intake.sessionsStarted} started`,
    `${intake.provisioned} provisioned (${conversion(intake.provisioned, intake.sessionsStarted)})`,
    `${intake.watchConsented} watch-consented (${conversion(intake.watchConsented, intake.provisioned)})`,
  ].join(' → ');
}

function ttfaLine(ttfa: TtfaStat): string {
  const label = 'TTFA p50 (first text → radar)';
  if (ttfa.p50Seconds === null) {
    return ttfa.notDerivableFamilies === 0
      ? `${label}: no data yet`
      : `${label}: no data yet (${ttfa.notDerivableFamilies} families not derivable)`;
  }
  const measured = `${label}: ${ttfa.p50Seconds}s across ${ttfa.derivedFamilies} families`;
  return ttfa.notDerivableFamilies === 0
    ? measured
    : `${measured} (${ttfa.notDerivableFamilies} not derivable)`;
}

function nudgeLine(nudges: NudgeEngagement): string {
  if (nudges.sent === 0) {
    return 'Nudge engagement (7d): no nudges sent yet';
  }
  if (nudges.matured === 0) {
    return `Nudge engagement (7d): ${nudges.sent} sent · none matured yet (48h not elapsed)`;
  }
  return `Nudge engagement (7d): ${nudges.sent} sent · ${nudges.matured} matured (48h elapsed) → ${nudges.replied} replied (${conversion(nudges.replied, nudges.matured)})`;
}

function cogsLine(cogs: LlmCogs): string {
  if (cogs.families === 0) {
    return 'LLM COGS (7d): no recorded LLM cost yet';
  }
  const perFamily = cogs.totalUsd / cogs.families;
  return `LLM COGS (7d): $${cogs.totalUsd.toFixed(4)} across ${cogs.families} families → $${perFamily.toFixed(4)} per family`;
}

/** The scoreboard block, one line per metric. Pure, and counts only — no family,
 * child or parent detail ever enters this text (rule #1). */
export function formatFunnelScoreboard(scoreboard: FunnelScoreboard): string[] {
  return [
    intakeLine(scoreboard.intake),
    ttfaLine(scoreboard.ttfa),
    nudgeLine(scoreboard.nudges),
    cogsLine(scoreboard.cogs),
  ];
}

// ── aggregation ──────────────────────────────────────────────────────────────

/** Legs that actually left. A nudge that was suppressed had no chance to be engaged
 * with, and a message that was suppressed reached nobody — the same question, so the
 * founder scorecard's engagement row reads this list too rather than a second copy. */
export const DELIVERED_STATUSES = ['sent', 'delivered'] as const;

export async function aggregateFunnelScoreboard(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<FunnelScoreboard> {
  const startedInWindow = and(
    gte(schema.smsIntakeSessions.createdAt, windowStart),
    lt(schema.smsIntakeSessions.createdAt, windowEnd),
  );

  const [startedRow] = await database
    .select({ count: count() })
    .from(schema.smsIntakeSessions)
    .where(startedInWindow);

  const [provisionedRow] = await database
    .select({ count: count() })
    .from(schema.smsIntakeSessions)
    .where(and(startedInWindow, isNotNull(schema.smsIntakeSessions.familyId)));

  // The attributed slice of the same cohort — same table, same window, so the two
  // numbers can never be counted over different weeks.
  const [sourceCodedRow] = await database
    .select({ count: count() })
    .from(schema.smsIntakeSessions)
    .where(and(startedInWindow, isNotNull(schema.smsIntakeSessions.sourceCode)));

  // Watch opt-in is a CONVERSION count — the families that said yes at S3 — so it
  // counts assent events. It is deliberately NOT a "is the watch consent live now?"
  // read: that question needs latest-row-wins over the append-only ledger, and this
  // number must not be reused for one.
  const [watchRow] = await database
    .select({ count: countDistinct(schema.smsIntakeSessions.familyId) })
    .from(schema.smsIntakeSessions)
    .innerJoin(
      schema.consentRecords,
      eq(schema.consentRecords.familyId, schema.smsIntakeSessions.familyId),
    )
    .where(
      and(
        startedInWindow,
        eq(schema.consentRecords.consentType, 'proactive_watch'),
        eq(schema.consentRecords.granted, true),
      ),
    );

  // The TTFA cohort is families PROVISIONED in the window, with their whole intake
  // exchange — an intake runs in minutes, so slicing its messages by the window too
  // would cut a conversation in half at the boundary.
  const intakeRows = await database
    .select({
      familyId: schema.channelMessages.familyId,
      direction: schema.channelMessages.direction,
      sentAt: schema.channelMessages.sentAt,
      familyCreatedAt: schema.families.createdAt,
    })
    .from(schema.channelMessages)
    .innerJoin(schema.families, eq(schema.families.id, schema.channelMessages.familyId))
    .where(
      and(
        eq(schema.channelMessages.category, 'intake'),
        gte(schema.families.createdAt, windowStart),
        lt(schema.families.createdAt, windowEnd),
      ),
    );

  const nudgeRows = await database
    .select({ familyId: schema.channelMessages.familyId, sentAt: schema.channelMessages.sentAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.category, 'nudge'),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...DELIVERED_STATUSES]),
        isNotNull(schema.channelMessages.sentAt),
        gte(schema.channelMessages.sentAt, windowStart),
        lt(schema.channelMessages.sentAt, windowEnd),
      ),
    );

  // Every matured nudge's 48h window closes inside [windowStart, windowEnd), so the
  // window's own inbound rows are the complete reply set for the nudges being scored.
  const replyRows = await database
    .select({ familyId: schema.channelMessages.familyId, sentAt: schema.channelMessages.sentAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'in'),
        isNotNull(schema.channelMessages.sentAt),
        gte(schema.channelMessages.sentAt, windowStart),
        lt(schema.channelMessages.sentAt, windowEnd),
      ),
    );

  // Runs with no recorded cost are excluded from BOTH sides, so the divisor is the
  // families the summed dollars actually came from.
  const [cogsRow] = await database
    .select({
      totalUsd: sum(schema.agentRuns.costUsd),
      families: countDistinct(schema.agentRuns.familyId),
    })
    .from(schema.agentRuns)
    .where(
      and(
        gte(schema.agentRuns.startedAt, windowStart),
        lt(schema.agentRuns.startedAt, windowEnd),
        isNotNull(schema.agentRuns.costUsd),
      ),
    );

  return {
    intake: {
      sessionsStarted: startedRow?.count ?? 0,
      provisioned: provisionedRow?.count ?? 0,
      watchConsented: watchRow?.count ?? 0,
      sourceCoded: sourceCodedRow?.count ?? 0,
    },
    ttfa: computeTtfa(intakeRows),
    nudges: computeNudgeEngagement(withSentAt(nudgeRows), withSentAt(replyRows), windowEnd),
    cogs: {
      totalUsd: Number(cogsRow?.totalUsd ?? 0),
      families: cogsRow?.families ?? 0,
    },
  };
}

/** Narrows rows the query already filtered to `sent_at IS NOT NULL`. */
function withSentAt<T extends { sentAt: Date | null }>(rows: T[]): Array<T & { sentAt: Date }> {
  return rows.filter((row): row is T & { sentAt: Date } => row.sentAt !== null);
}

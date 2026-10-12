import { type Database, schema } from '@hale/db';
import { and, eq, gt, gte, inArray, isNull, like, lt, notInArray, or, sql } from 'drizzle-orm';
import { percentileNearestRank } from '~/lib/loop/funnel-scoreboard';
import { resolveOpsExclusions } from '~/lib/loop/metrics-scope';
import { alertCode } from '~/lib/monitoring/delivery-health';
import {
  DEAD_LETTER_PAGE_ROUTE,
  FIRST_HELLO_PAGE_ROUTE,
  TURN_DEFERRED_AUDIT_ACTION,
  TURN_FAILED_AUDIT_ACTION,
  failureCategory,
  parseDeadLetterIdentifier,
  parseHelloIdentifier,
} from '~/lib/monitoring/failure-page';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import { type ReplyLatencyStat, computeReplyLatency } from '~/lib/monitoring/reply-latency';

/**
 * VIL-409 — one daily #ops post over every real family: reply latency from the turn
 * ledger, unanswered steps, failed and held sends, failed turns, prompt-cache reads
 * and recorded spend.
 *
 * Monitoring only. Nothing here caps, holds, delays or suppresses a send, and nothing
 * is texted to a parent. The spend figure is a number to read, never a ceiling.
 *
 * Counts only (rule #1, and the repo is public): the report type has no id field and
 * no free text. The only strings that reach the post are closed-vocabulary reasons
 * (through `failureCategory`, which turns a phone-length digit run into `redacted`),
 * provider codes (through `alertCode`) and agent names (a pg enum).
 *
 * Real families are the families active in the window minus `resolveOpsExclusions`:
 * the METRICS_EXCLUDED_FAMILY_IDS list, the founder's household and every household
 * with a channel in the probe range (the canary and the live probes).
 */

export const OPS_DAILY_ROUTE = 'ops:daily';

/** An unanswered 1:1 inbound older than this is a gap. A monitoring threshold only. */
export const OPS_DAILY_GAP_AFTER_MS = 15 * 60_000;

/** Same data values wiring.ts writes. ops-daily.test.ts pins the spellings. */
export const TURN_ANSWERED_AUDIT_ACTION = 'sms_turn_answered';
export const TURN_UNANSWERED_AUDIT_ACTION = 'sms_turn_unanswered';

const WINDOW_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/** The turn ledger's target table, as wiring.ts writes it. */
const TURN_LEDGER_TARGET = 'channel_messages';

/** The pipes a text turn arrives and leaves on; email has no turn ledger. */
const TEXT_CHANNELS = ['sms', 'imessage'] as const;

/** Sends that reached the provider: the same denominator as loadDeliveryStats. */
const ATTEMPTED_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const;

/** Claim encoding: count 1 = posted, a unix-second stamp = a post in progress. */
const CLAIM_EPOCH = new Date(0);
const POSTED_COUNT = 1;
const STALE_CLAIM_MS = 2 * 60_000;

export interface OpsDailyReport {
  window: { start: Date; end: Date };
  families: { real: number; excluded: number };
  replies: ReplyLatencyStat;
  /** `sms_turn_unanswered` rows by reason. */
  unanswered: Array<{ reason: string; count: number }>;
  sends: { attempted: number; failed: number; codes: Array<{ code: string; count: number }> };
  /** Outbound texts Hale held back, by their suppression status. */
  held: Array<{ reason: string; count: number }>;
  turns: {
    /** `sms_turn_failed` rows by reason. */
    failed: Array<{ reason: string; count: number }>;
    deferred: number;
    providerDeferred: { billing: number; auth: number };
    deadLettered: number;
    firstHelloFailures: number;
  };
  cache: Array<{
    agentName: string;
    runs: number;
    hitRuns: number;
    tokenRate: number | null;
    tokenRuns: number;
    latencyP95Ms: number | null;
  }>;
  spend: {
    totalUsd: number;
    families: number;
    medianUsd: number | null;
    p95Usd: number | null;
    maxUsd: number | null;
  };
}

export type OpsDailyOutcome = 'posted' | 'already_posted' | 'failed' | 'skipped_not_configured';

/** The 24h ending on the hour `now` falls in. */
export function opsDailyWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  return { start: new Date(end.getTime() - WINDOW_MS), end };
}

function byCountThenName<T extends { count: number }>(key: (row: T) => string) {
  return (a: T, b: T) => b.count - a.count || key(a).localeCompare(key(b));
}

async function activeFamilyIds(
  database: Database,
  window: { start: Date; end: Date },
): Promise<string[]> {
  const m = schema.channelMessages;
  const r = schema.agentRuns;
  const messages = await database
    .selectDistinct({ familyId: m.familyId })
    .from(m)
    .where(
      and(
        gte(m.createdAt, new Date(window.start.getTime() - OPS_DAILY_GAP_AFTER_MS)),
        lt(m.createdAt, window.end),
      ),
    );
  const runs = await database
    .selectDistinct({ familyId: r.familyId })
    .from(r)
    .where(and(gte(r.startedAt, window.start), lt(r.startedAt, window.end)));
  return [...new Set([...messages, ...runs].map((row) => row.familyId))];
}

/**
 * Inbound text turns from `[start - gap, end - gap)`, so each has had its full gap
 * window, each with the earliest `sms_turn_answered` row that names it.
 *
 * Latency is measured on the database's clock at both ends (the inbound row's
 * created_at, the ledger row's occurred_at). The provider's receive time would come
 * from another clock, and a skew there could put an answer before its question.
 */
async function loadInboundTurns(
  database: Database,
  realIds: string[],
  window: { start: Date; end: Date },
) {
  const m = schema.channelMessages;
  const a = schema.auditLog;
  const g = schema.linqGroupMembers;
  // Drizzle renders a column bare inside a subquery, where `id` and `family_id` would
  // bind to the inner table. The outer row's columns are named through their table.
  const outer = (column: string) => sql`${m}.${sql.identifier(column)}`;
  return database
    .select({
      id: m.id,
      inboundAt: m.createdAt,
      answeredAt:
        sql<Date | null>`(select min(${a.occurredAt}) from ${a} where ${a.familyId} = ${outer('family_id')} and ${a.actionTaken} = ${TURN_ANSWERED_AUDIT_ACTION} and ${a.targetTable} = ${TURN_LEDGER_TARGET} and ${a.targetId} = ${outer('id')}::text)`.mapWith(
          a.occurredAt,
        ),
      inGroup: sql<boolean>`exists (select 1 from ${g} where ${g.chatId} = ${outer('provider_chat_id')})`,
    })
    .from(m)
    .where(
      and(
        inArray(m.familyId, realIds),
        eq(m.direction, 'in'),
        eq(m.category, 'reply'),
        inArray(m.channel, [...TEXT_CHANNELS]),
        gte(m.createdAt, new Date(window.start.getTime() - OPS_DAILY_GAP_AFTER_MS)),
        lt(m.createdAt, new Date(window.end.getTime() - OPS_DAILY_GAP_AFTER_MS)),
      ),
    );
}

async function ledgerReasons(
  database: Database,
  action: string,
  realIds: string[],
  window: { start: Date; end: Date },
): Promise<Array<{ reason: string; count: number }>> {
  const a = schema.auditLog;
  const reason = sql<string | null>`${a.after} ->> 'reason'`;
  const rows = await database
    .select({ reason, count: sql<number>`count(*)::int` })
    .from(a)
    .where(
      and(
        inArray(a.familyId, realIds),
        eq(a.actionTaken, action),
        gte(a.occurredAt, window.start),
        lt(a.occurredAt, window.end),
      ),
    )
    .groupBy(reason);
  // A row written before its writer recorded a reason has none; that is a reason too.
  return rows
    .map((row) => ({ reason: row.reason ?? 'unknown', count: row.count }))
    .sort(byCountThenName((row) => row.reason));
}

async function loadDeferred(
  database: Database,
  realIds: string[],
  window: { start: Date; end: Date },
) {
  const a = schema.auditLog;
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      billing: sql<number>`count(*) filter (where ${a.after} ->> 'providerFailure' = 'billing')::int`,
      auth: sql<number>`count(*) filter (where ${a.after} ->> 'providerFailure' = 'auth')::int`,
    })
    .from(a)
    .where(
      and(
        inArray(a.familyId, realIds),
        eq(a.actionTaken, TURN_DEFERRED_AUDIT_ACTION),
        gte(a.occurredAt, window.start),
        lt(a.occurredAt, window.end),
      ),
    );
  if (!row) throw new Error('ops daily: the deferred count returned no row');
  return row;
}

async function loadSends(
  database: Database,
  realIds: string[],
  window: { start: Date; end: Date },
) {
  const m = schema.channelMessages;
  const scope = and(
    inArray(m.familyId, realIds),
    eq(m.direction, 'out'),
    inArray(m.channel, [...TEXT_CHANNELS]),
    gte(m.createdAt, window.start),
    lt(m.createdAt, window.end),
  );
  const [totals] = await database
    .select({
      attempted: sql<number>`count(*) filter (where ${inArray(m.status, [...ATTEMPTED_STATUSES])})::int`,
      failed: sql<number>`count(*) filter (where ${m.status} = 'failed')::int`,
    })
    .from(m)
    .where(scope);
  if (!totals) throw new Error('ops daily: the send totals returned no row');
  const codes = await database
    .select({ code: m.errorCode, count: sql<number>`count(*)::int` })
    .from(m)
    .where(and(scope, eq(m.status, 'failed')))
    .groupBy(m.errorCode);
  const held = await database
    .select({ reason: m.status, count: sql<number>`count(*)::int` })
    .from(m)
    .where(and(scope, like(sql`${m.status}::text`, 'suppressed_%')))
    .groupBy(m.status);
  return {
    sends: {
      attempted: totals.attempted,
      failed: totals.failed,
      codes: codes
        .filter((row): row is { code: string; count: number } => row.code !== null)
        .sort(byCountThenName((row) => row.code)),
    },
    held: held.sort(byCountThenName((row) => row.reason)),
  };
}

/** Dead-letter claims (failure-page.ts) whose message is one of the window's inbounds. */
async function countDeadLettered(database: Database, inboundIds: Set<string>): Promise<number> {
  const claims = await database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, DEAD_LETTER_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
      ),
    );
  const messages = new Set<string>();
  for (const claim of claims) {
    const parsed = parseDeadLetterIdentifier(claim.identifier);
    if (parsed && inboundIds.has(parsed.channelMessageId)) messages.add(parsed.channelMessageId);
  }
  return messages.size;
}

/** First-hello claims whose intake session opened in the window. A session that
 * already belongs to an excluded family is not counted; one with no family yet is. */
async function countFirstHelloFailures(
  database: Database,
  excluded: Set<string>,
  window: { start: Date; end: Date },
): Promise<number> {
  const claims = await database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
      ),
    );
  const sessionIds = [
    ...new Set(claims.flatMap((claim) => parseHelloIdentifier(claim.identifier)?.sessionId ?? [])),
  ];
  const s = schema.smsIntakeSessions;
  const sessions = await database
    .select({ id: s.id })
    .from(s)
    .where(
      and(
        inArray(s.id, sessionIds),
        gte(s.createdAt, window.start),
        lt(s.createdAt, window.end),
        or(isNull(s.familyId), notInArray(s.familyId, [...excluded])),
      ),
    );
  return sessions.length;
}

async function loadRuns(database: Database, realIds: string[], window: { start: Date; end: Date }) {
  const r = schema.agentRuns;
  return database
    .select({
      familyId: r.familyId,
      agentName: r.agentName,
      promptCacheHit: r.promptCacheHit,
      cacheReadTokens: r.cacheReadTokens,
      promptTokens: r.promptTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    })
    .from(r)
    .where(
      and(
        inArray(r.familyId, realIds),
        gte(r.startedAt, window.start),
        lt(r.startedAt, window.end),
      ),
    );
}

type RunRow = Awaited<ReturnType<typeof loadRuns>>[number];

function summarizeCache(rows: RunRow[]): OpsDailyReport['cache'] {
  const byAgent = new Map<string, RunRow[]>();
  for (const row of rows) {
    byAgent.set(row.agentName, [...(byAgent.get(row.agentName) ?? []), row]);
  }
  return [...byAgent.entries()]
    .map(([agentName, agentRows]) => {
      const measured = agentRows.filter((row) => row.promptCacheHit !== null);
      const tokenRows = agentRows.filter((row) => row.cacheReadTokens !== null);
      const read = tokenRows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0);
      const fresh = tokenRows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0);
      return {
        agentName,
        runs: measured.length,
        hitRuns: measured.filter((row) => row.promptCacheHit === true).length,
        tokenRate: read + fresh > 0 ? read / (read + fresh) : null,
        tokenRuns: tokenRows.length,
        latencyP95Ms: percentileNearestRank(
          agentRows.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs])),
          0.95,
        ),
      };
    })
    .sort((a, b) => b.runs - a.runs || a.agentName.localeCompare(b.agentName));
}

/** Recorded spend per real family. A lower bound: not every model call records a run. */
function summarizeSpend(rows: RunRow[]): OpsDailyReport['spend'] {
  const perFamily = new Map<string, number>();
  for (const row of rows) {
    if (row.costUsd === null) continue;
    perFamily.set(row.familyId, (perFamily.get(row.familyId) ?? 0) + Number(row.costUsd));
  }
  const totals = [...perFamily.values()];
  return {
    totalUsd: totals.reduce((sum, value) => sum + value, 0),
    families: totals.length,
    medianUsd: percentileNearestRank(totals, 0.5),
    p95Usd: percentileNearestRank(totals, 0.95),
    maxUsd: percentileNearestRank(totals, 1),
  };
}

export async function aggregateOpsDaily(database: Database, now: Date): Promise<OpsDailyReport> {
  const window = opsDailyWindow(now);
  const active = await activeFamilyIds(database, window);
  const excluded = await resolveOpsExclusions(database, active);
  const realIds = active.filter((id) => !excluded.has(id));

  const inbound = await loadInboundTurns(database, realIds, window);
  const { sends, held } = await loadSends(database, realIds, window);
  const deferred = await loadDeferred(database, realIds, window);
  const runs = await loadRuns(database, realIds, window);

  return {
    window,
    families: { real: realIds.length, excluded: active.length - realIds.length },
    replies: computeReplyLatency(inbound, window.end, OPS_DAILY_GAP_AFTER_MS),
    unanswered: await ledgerReasons(database, TURN_UNANSWERED_AUDIT_ACTION, realIds, window),
    sends,
    held,
    turns: {
      failed: await ledgerReasons(database, TURN_FAILED_AUDIT_ACTION, realIds, window),
      deferred: deferred.total,
      providerDeferred: { billing: deferred.billing, auth: deferred.auth },
      deadLettered: await countDeadLettered(database, new Set(inbound.map((row) => row.id))),
      firstHelloFailures: await countFirstHelloFailures(database, excluded, window),
    },
    cache: summarizeCache(runs),
    spend: summarizeSpend(runs),
  };
}

// ── the post ─────────────────────────────────────────────────────────────────

function seconds(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m${String(value % 60).padStart(2, '0')}s`;
}

function usd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(2)}`;
}

function tally(rows: Array<{ reason: string; count: number }>): string {
  return rows.map((row) => `${failureCategory(row.reason)} ${row.count}`).join(', ');
}

/** The #ops text. ASCII, counts and closed-vocabulary reasons only. */
export function composeOpsDailyPost(report: OpsDailyReport): string {
  const end = `${report.window.end.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const r = report.replies;
  const failedTurns = report.turns.failed.reduce((sum, row) => sum + row.count, 0);
  const codes = report.sends.codes.map((row) => `${alertCode(row.code)} x${row.count}`).join(', ');
  const cache = report.cache.map((row) => {
    const rate = row.tokenRate === null ? 'n/a' : `${Math.round(row.tokenRate * 100)}%`;
    const p95 = row.latencyP95Ms === null ? 'n/a' : `${(row.latencyP95Ms / 1000).toFixed(1)}s`;
    return `${row.agentName} ${row.hitRuns}/${row.runs} runs, tokens ${rate} (${row.tokenRuns} runs), p95 ${p95}`;
  });
  const spend = report.spend;

  return [
    `Hale daily | 24h to ${end} | real families ${report.families.real} | excluded ${report.families.excluded}`,
    `Replies (1:1): ${r.inbound} in | p50 ${seconds(r.p50Seconds)} | p95 ${seconds(r.p95Seconds)} | max ${seconds(r.maxSeconds)} | gaps>15m ${r.gaps} | pending ${r.pending} | group ${r.groupInbound} in / ${r.groupAnswered} answered`,
    `Unanswered steps: ${report.unanswered.length > 0 ? tally(report.unanswered) : 'none'}`,
    `Sends: ${report.sends.failed} failed of ${report.sends.attempted}${codes ? ` | codes: ${codes}` : ''}`,
    `Held: ${report.held.length > 0 ? tally(report.held) : 'none'}`,
    `Turns: failed ${failedTurns}${failedTurns > 0 ? ` (${tally(report.turns.failed)})` : ''} | deferred ${report.turns.deferred} (billing ${report.turns.providerDeferred.billing}, auth ${report.turns.providerDeferred.auth}) | dead-lettered ${report.turns.deadLettered} | first-hello failures ${report.turns.firstHelloFailures}`,
    `Cache: ${cache.length > 0 ? cache.join(' | ') : 'none'}`,
    spend.families > 0
      ? `Spend (recorded runs): ${usd(spend.totalUsd)} | ${spend.families} families | median ${usd(spend.medianUsd)} | p95 ${usd(spend.p95Usd)} | max ${usd(spend.maxUsd)}`
      : `Spend (recorded runs): ${usd(spend.totalUsd)} | 0 families`,
  ].join('\n');
}

// ── claim and post ───────────────────────────────────────────────────────────

function claimStamp(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function claimKey(identifier: string) {
  return and(
    eq(schema.rateLimits.route, OPS_DAILY_ROUTE),
    eq(schema.rateLimits.identifier, identifier),
    eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
  );
}

/** The rate_limits unique index is the lock. A stamp older than two minutes is a
 * crashed poster and is taken over; count 1 is a post that already landed. */
async function claimDay(database: Database, identifier: string, stamp: number, now: Date) {
  const inserted = await database
    .insert(schema.rateLimits)
    .values({ identifier, route: OPS_DAILY_ROUTE, windowStart: CLAIM_EPOCH, count: stamp })
    .onConflictDoNothing({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
    })
    .returning({ id: schema.rateLimits.id });
  if (inserted.length > 0) return true;

  const staleBefore = claimStamp(new Date(now.getTime() - STALE_CLAIM_MS));
  const taken = await database
    .update(schema.rateLimits)
    .set({ count: stamp })
    .where(
      and(
        claimKey(identifier),
        gt(schema.rateLimits.count, POSTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    )
    .returning({ id: schema.rateLimits.id });
  return taken.length > 0;
}

/**
 * Aggregate, claim the day, post. A refused or unconfigured post releases the claim,
 * logs, and returns its named outcome, so the next run (or a manual GET with the
 * cron secret) posts. Never texts anyone.
 */
export async function runOpsDaily(
  database: Database,
  deps: { post: (text: string) => Promise<OpsPageOutcome>; now?: Date },
): Promise<OpsDailyOutcome> {
  const now = deps.now ?? new Date();
  const report = await aggregateOpsDaily(database, now);
  const identifier = report.window.end.toISOString().slice(0, 10);
  const stamp = claimStamp(now);

  if (!(await claimDay(database, identifier, stamp, now))) return 'already_posted';

  const outcome = await deps.post(composeOpsDailyPost(report));
  const ours = and(claimKey(identifier), eq(schema.rateLimits.count, stamp));
  if (outcome === 'sent') {
    await database.update(schema.rateLimits).set({ count: POSTED_COUNT }).where(ours);
    return 'posted';
  }
  await database.delete(schema.rateLimits).where(ours);
  console.error('ops daily: the #ops post did not land — claim released', { outcome });
  return outcome;
}

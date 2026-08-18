import { type Database, schema } from '@hale/db';
import { and, count, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { type CommitmentDebt, aggregateCommitmentDebt } from '~/lib/commitments/ledger';
import { LOOP_EMAIL_TYPES } from '~/lib/cron/email-compliance';
import {
  PROVIDER_INCIDENT_ROUTE,
  providerIncidentKind,
} from '~/lib/monitoring/provider-health';
import {
  aggregateFunnelScoreboard,
  type FunnelScoreboard,
  formatFunnelScoreboard,
} from './funnel-scoreboard';

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
  /** VIL-273 · what parents asked for that Hale does not do, bucketed. Any order —
   * the formatter ranks it. */
  unmetIntents: UnmetIntentRow[];
}

/** Sums channel_messages (outbound legs) by channel/category/status, the loop_stop
 * count (email_opt_outs rows landed on a loop stream), and week_plans composed —
 * all within [windowStart, windowEnd). */
export async function aggregateLoopHealth(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<LoopHealthSummary> {
  const messageCounts = await database
    .select({
      channel: schema.channelMessages.channel,
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
    .groupBy(schema.channelMessages.channel, schema.channelMessages.category, schema.channelMessages.status);

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

  // MEM-10 · read as of the window's END rather than over the window, because debt is a
  // balance. NEVER a send: this sweep's whole job is that the debt is VISIBLE to the
  // founder, and texting a family "sorry, I still owe you" is a send-policy decision
  // nobody has made yet.
  const commitmentDebt = await aggregateCommitmentDebt(database, windowEnd);

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
    // The check constraint makes a half-stamped row unwritable, so a lane implies a
    // category; the coalesce is a type narrowing, not a guess about missing data.
    unmetIntents: unmetRows.map((row) => ({
      lane: row.lane ?? 'unknown',
      category: row.category ?? 'unknown',
      count: row.count,
    })),
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

/** Plain-text founder digest body. Pure — no DB, no network — so the format is
 * unit-tested against worked summaries. Counts only (rule #1): no family/child/
 * parent identifying detail ever enters this text. */
export function formatLoopHealthDigest(summary: LoopHealthSummary): string {
  const lines: string[] = [
    `Hale · loop health · ${isoDate(summary.windowStart)} – ${isoDate(summary.windowEnd)}`,
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
      lines.push(`  ${row.channel} · ${row.category} · ${row.status}: ${row.count}`);
    }
  }
  return lines.join('\n');
}

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

export interface LoopHealthDigestSender {
  /** Returns true when the provider accepted the send. */
  send(body: string): Promise<boolean>;
}

export function createLoopHealthDigestSender(client?: Resend): LoopHealthDigestSender {
  return {
    async send(body) {
      const to = founderAddress();
      if (!to) {
        return false;
      }
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        return false;
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await transport.send({
        from,
        to,
        subject: 'Hale · weekly loop health',
        text: body,
      });
      return !error;
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
}

export function defaultLoopHealthDigestDeps(): LoopHealthDigestDeps {
  return { aggregate: aggregateLoopHealth, sender: createLoopHealthDigestSender() };
}

export interface LoopHealthDigestResult {
  sent: boolean;
  summary: LoopHealthSummary;
}

/** The weekly cron entry point: aggregate the trailing week and email the founder.
 * Un-gated by a feature flag (like founder-signal's notifySignup) — it degrades to
 * a clean no-op via the sender's own guards (no founder address / no Resend key)
 * rather than a separate send-enabled switch, since this never reaches a real
 * family. */
export async function runLoopHealthDigestCron(
  database: Database,
  deps: LoopHealthDigestDeps = defaultLoopHealthDigestDeps(),
  now: Date = new Date(),
): Promise<LoopHealthDigestResult> {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const summary = await deps.aggregate(database, windowStart, windowEnd);
  const sent = await deps.sender.send(formatLoopHealthDigest(summary));
  return { sent, summary };
}

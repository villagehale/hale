import { type Database, schema } from '@hale/db';
import { and, count, gte, inArray, lt } from 'drizzle-orm';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { LOOP_EMAIL_TYPES } from '~/lib/cron/email-compliance';

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

export interface LoopHealthSummary {
  windowStart: Date;
  windowEnd: Date;
  messageCounts: MessageCountRow[];
  stopCount: number;
  weekPlansComposed: number;
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

  return {
    windowStart,
    windowEnd,
    messageCounts,
    stopCount: stopRow?.count ?? 0,
    weekPlansComposed: plansRow?.count ?? 0,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    '',
    'Messages by channel / category / status:',
  ];
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

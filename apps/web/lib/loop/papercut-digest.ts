import { type Database, type ReplySourceValue, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { TURN_FAILED_ACTION } from '~/lib/channel/router/wiring';
import { createResendTransport } from '~/lib/channel/resend-transport';
import { escalateDigestSendFailure } from '~/lib/monitoring/provider-health';

/**
 * PAPERCUT RECORDER v1 — the weekly ledger of every moment Hale degraded and a row was
 * left behind: the eval-fixture shopping list.
 *
 * Reads the FOUR persisted degradation sources and nothing console-only (honest scope —
 * the intake gate refusals and the channel-voice fallbacks have no row to read and are
 * flagged as future hooks, not silently approximated):
 *
 *   unmet_intent     — channel_messages.unmet_lane/unmet_category (migration 0080): what
 *                      parents asked for that Hale said no to, bucketed.
 *   medical_fallback — channel_messages.medical_reply_source = 'fixed' (migration 0090):
 *                      a hurt-child question answered with the 811/911 line because the
 *                      composed answer failed twice.
 *   reply_fallback   — channel_messages.reply_source in the four composer-failure values
 *                      (migration 0103): the general answer that could not be written.
 *   voice_failure    — agent_runs status='failed' across the loop voice family: a send
 *                      that went out on deterministic copy instead of the composed voice.
 *   turn_failure     — audit_log 'sms_turn_failed' rows: a turn that broke and put an
 *                      apology/receipt in front of a parent (turn-ledger.ts reasons).
 *
 * THE DIGEST IS COUNTS, CLOSED-VOCAB BUCKETS AND ROW IDS — NEVER PARENT TEXT (rule #1).
 * Every bucket label here is drawn from an enum or a CHECK-constrained column; the ids
 * are what let the founder pull the underlying row server-side (hale-prod-qa) when a
 * papercut is worth hand-writing into an eval fixture. Fixtures live in-repo and are
 * founder-written: this recorder lists candidates, it never edits a skill or a fixture.
 */

export type PapercutSource =
  | 'unmet_intent'
  | 'medical_fallback'
  | 'reply_fallback'
  | 'voice_failure'
  | 'turn_failure';

export interface PapercutBucket {
  source: PapercutSource;
  /** Closed-vocabulary label: `lane · category`, a reply-source value, an agent name,
   * or a turn-failure reason. Never words a parent typed. */
  bucket: string;
  count: number;
  /** The rows behind the count: channel_messages.id (unmet/medical/reply), agent_runs.id
   * (voice), or the audit row's channel_messages target id (turn). Safe in email — an
   * id discloses nothing and resolves only server-side. */
  rowIds: string[];
}

export interface PapercutSummary {
  windowStart: Date;
  windowEnd: Date;
  /** Any order — the formatter ranks within each source. */
  buckets: PapercutBucket[];
}

/**
 * Source F's closed family: the loop-voice composers that record a 'failed' run when the
 * model's voice was rejected and the deterministic copy went out (loop/voice/compose.ts
 * plus the intake radar and nudge voices on the same seam). A failed run under any OTHER
 * agent name is a different kind of problem with its own surface — widening this list is
 * a deliberate edit, not a default.
 */
const VOICE_FAILURE_AGENTS = [
  'weekly-plan-voice',
  'welcome-voice',
  'reminder-voice',
  'radar-voice',
  'nudge-voice',
] as const;

/** The reply_source values that are papercuts: the composer could not run and the fixed
 * ANSWER_UNAVAILABLE line stood in. 'composed'/'web_grounded'/'fixed' are outcomes the
 * product chose, not degradations. */
const REPLY_FALLBACK_SOURCES = [
  'client_unavailable',
  'skill_unavailable',
  'model_failed',
  'unsendable',
] as const satisfies readonly ReplySourceValue[];

function toBuckets(
  source: PapercutSource,
  rows: Array<{ bucket: string; id: string }>,
): PapercutBucket[] {
  const byLabel = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byLabel.get(row.bucket) ?? [];
    ids.push(row.id);
    byLabel.set(row.bucket, ids);
  }
  return [...byLabel].map(([bucket, rowIds]) => ({
    source,
    bucket,
    count: rowIds.length,
    rowIds,
  }));
}

/** The week's papercuts, one query per persisted source, all `[windowStart, windowEnd)`.
 * Ids ride along with the counts because the id is the whole retrieval path — the digest
 * carries no text, so a bucket without its rows would be a number nobody can act on. */
export async function aggregatePapercuts(
  database: Database,
  windowStart: Date,
  windowEnd: Date,
): Promise<PapercutSummary> {
  const messageWindow = and(
    gte(schema.channelMessages.createdAt, windowStart),
    lt(schema.channelMessages.createdAt, windowEnd),
  );

  const unmetRows = await database
    .select({
      id: schema.channelMessages.id,
      lane: schema.channelMessages.unmetLane,
      category: schema.channelMessages.unmetCategory,
    })
    .from(schema.channelMessages)
    .where(and(isNotNull(schema.channelMessages.unmetLane), messageWindow));

  const medicalRows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.medicalReplySource, 'fixed'),
        messageWindow,
      ),
    );

  const replyFallbackRows = await database
    .select({ id: schema.channelMessages.id, source: schema.channelMessages.replySource })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.replySource, [...REPLY_FALLBACK_SOURCES]),
        messageWindow,
      ),
    );

  const voiceRows = await database
    .select({ id: schema.agentRuns.id, agentName: schema.agentRuns.agentName })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.status, 'failed'),
        inArray(schema.agentRuns.agentName, [...VOICE_FAILURE_AGENTS]),
        gte(schema.agentRuns.startedAt, windowStart),
        lt(schema.agentRuns.startedAt, windowEnd),
      ),
    );

  // The reason lives inside the audit row's `after` jsonb ({lane, reason} — both closed
  // vocabularies by the writer's contract, wiring.ts recordFailed). The row id reported
  // is the TARGET: the inbound message the turn broke on, which is the row worth pulling.
  const turnRows = await database
    .select({
      id: sql<string>`coalesce(${schema.auditLog.targetId}, ${schema.auditLog.id}::text)`,
      reason: sql<string>`coalesce(${schema.auditLog.after} ->> 'reason', 'unknown')`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_FAILED_ACTION),
        gte(schema.auditLog.occurredAt, windowStart),
        lt(schema.auditLog.occurredAt, windowEnd),
      ),
    );

  return {
    windowStart,
    windowEnd,
    buckets: [
      // The check constraint makes a half-stamped pair unwritable; the coalesce is a
      // type narrowing, not a guess (same seam as the health digest's unmet read).
      ...toBuckets(
        'unmet_intent',
        unmetRows.map((r) => ({
          id: r.id,
          bucket: `${r.lane ?? 'unknown'} · ${r.category ?? 'unknown'}`,
        })),
      ),
      ...toBuckets(
        'medical_fallback',
        medicalRows.map((r) => ({ id: r.id, bucket: 'fixed' })),
      ),
      ...toBuckets(
        'reply_fallback',
        replyFallbackRows.map((r) => ({ id: r.id, bucket: r.source ?? 'unknown' })),
      ),
      ...toBuckets(
        'voice_failure',
        voiceRows.map((r) => ({ id: r.id, bucket: r.agentName })),
      ),
      ...toBuckets(
        'turn_failure',
        turnRows.map((r) => ({ id: r.id, bucket: r.reason })),
      ),
    ],
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ids shown per bucket. The COUNT stays exact; ids beyond this are '+N more' — a
 * 100-row bucket must not turn the digest into a wall of uuids when any one row is
 * enough to start pulling the thread. */
const MAX_IDS_SHOWN = 10;

/** What each source means, and where its ids resolve — one line the founder reads in
 * the email instead of in this file. Static copy: the machine describing its own
 * refusal shapes, never anything a parent said. */
const SOURCE_HEADINGS: Record<PapercutSource, string> = {
  unmet_intent: 'Unmet intents (inbound channel_messages ids - Hale said no)',
  medical_fallback: "Medical answers that fell back to the fixed 811/911 line (outbound channel_messages ids)",
  reply_fallback:
    'General answers that could not be composed - the fixed unavailable line went out (outbound channel_messages ids)',
  voice_failure: 'Loop voices sent on deterministic copy (agent_runs ids)',
  turn_failure: 'Turns that broke and sent an apology/receipt (inbound channel_messages ids)',
};

const SOURCE_ORDER: readonly PapercutSource[] = [
  'unmet_intent',
  'medical_fallback',
  'reply_fallback',
  'voice_failure',
  'turn_failure',
];

/**
 * Plain-text founder digest body. Pure — no DB, no network — so the format is
 * unit-tested against worked summaries. Counts, closed-vocab buckets and row ids only
 * (rule #1): no parent words, no child, no family detail ever enters this text.
 */
export function formatPapercutDigest(summary: PapercutSummary): string {
  const lines: string[] = [
    `Hale · weekly papercuts · ${isoDate(summary.windowStart)} – ${isoDate(summary.windowEnd)}`,
    '',
    'Eval-fixture candidates: each row id resolves server-side (hale-prod-qa) when a',
    'bucket is worth a hand-written fixture. This email carries no parent text.',
  ];
  for (const source of SOURCE_ORDER) {
    const buckets = summary.buckets.filter((b) => b.source === source);
    if (buckets.length === 0) continue;
    lines.push('', `${SOURCE_HEADINGS[source]}:`);
    const ranked = [...buckets].sort(
      (a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket),
    );
    for (const row of ranked) {
      lines.push(`  ${row.bucket}: ${row.count}`);
      const shown = row.rowIds.slice(0, MAX_IDS_SHOWN);
      const more = row.rowIds.length - shown.length;
      lines.push(`    ids: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Whether the provider took the send — and when it did not, WHY, by name (rule #11):
 * a digest with nowhere to go is a different fact from a provider that refused one. */
export type PapercutSendOutcome =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'provider_error' };

export interface PapercutDigestSender {
  send(body: string): Promise<PapercutSendOutcome>;
}

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

/** The founder email leg, on the loop-health digest's exact pattern (founder-signal
 * Resend, internal ops mail, deliberately outside the parent-facing CASL ledger). */
export function createPapercutDigestSender(client?: Resend): PapercutDigestSender {
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
        subject: 'Hale · weekly papercuts',
        text: body,
      });
      return error ? { sent: false, reason: 'provider_error' } : { sent: true };
    },
  };
}

/** Same rolling window as the loop-health digest: the 7 days ending at `now`. */
const DIGEST_WINDOW_DAYS = 7;

export interface PapercutDigestDeps {
  aggregate: typeof aggregatePapercuts;
  sender: PapercutDigestSender;
  /** Escalate a refused send through the ops seam (provider-health incident, deduped
   * per digest per window). Required (rule #11): a digest whose failure only reaches
   * a cron JSON response has failed absent — the 2026-09-03 audit's exact finding. */
  escalate: (database: Database, reason: string) => Promise<void>;
}

export function defaultPapercutDigestDeps(): PapercutDigestDeps {
  return {
    aggregate: aggregatePapercuts,
    sender: createPapercutDigestSender(),
    escalate: async (database, reason) => {
      await escalateDigestSendFailure(database, 'papercut', reason);
    },
  };
}

/**
 * Every way the weekly run can end, named (rule #11). `digest_skipped_empty` is a REAL
 * measurement — a week in which nothing degraded — and it is a skip, never an empty
 * email: a founder trained to ignore blank digests stops reading the full ones.
 */
export type PapercutDigestOutcome =
  | 'sent'
  | 'digest_skipped_empty'
  | 'send_skipped_not_configured'
  | 'send_failed';

export interface PapercutDigestResult {
  outcome: PapercutDigestOutcome;
  summary: PapercutSummary;
}

/** The weekly cron entry point: aggregate the trailing week, skip an empty one by name,
 * otherwise email the founder the bucketed list. */
export async function runPapercutDigestCron(
  database: Database,
  deps: PapercutDigestDeps = defaultPapercutDigestDeps(),
  now: Date = new Date(),
): Promise<PapercutDigestResult> {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const summary = await deps.aggregate(database, windowStart, windowEnd);

  if (summary.buckets.length === 0) {
    console.info(
      { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
      'papercut digest: clean week, nothing degraded - skipping the email by name',
    );
    return { outcome: 'digest_skipped_empty', summary };
  }

  const send = await deps.sender.send(formatPapercutDigest(summary));
  if (send.sent) return { outcome: 'sent', summary };
  if (send.reason === 'not_configured') {
    console.error('papercut digest: no founder address/Resend key - digest composed, not sent');
    return { outcome: 'send_skipped_not_configured', summary };
  }
  console.error('papercut digest: provider refused the send');
  // Escalated, not just returned: a refused digest send would otherwise be a console
  // line in a response nobody reads, and a missing Monday email reads as a quiet week.
  await deps.escalate(database, send.reason);
  return { outcome: 'send_failed', summary };
}

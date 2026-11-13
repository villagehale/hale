import { type Database, schema } from '@hale/db';
import {
  type SQL,
  and,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import {
  TURN_ANSWERED_ACTION,
  TURN_FAILED_ACTION,
  TURN_FOLDED_ACTION,
  TURN_LEDGER_LOOKBACK_MS,
  TURN_LEDGER_TARGET,
} from '~/lib/channel/router/turn-ledger';
import { resolveOpsExclusions } from '~/lib/loop/metrics-scope';
import type { OpsPager, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import { OPS_DAILY_GAP_AFTER_MS, TURN_UNANSWERED_AUDIT_ACTION } from '~/lib/monitoring/ops-daily';
import { errorTrackingEnabled } from './flags';
import { captureErrorEventAsync } from './product';

/**
 * Inbound texts with no `sms_turn_answered` after N minutes. A Vercel cron drives
 * this (Hale has no pg-boss scheduler). Each inbound is claimed once via rate_limits
 * so a re-tick does not re-alert. Claims are not audit_log rows: this must not appear
 * on a parent's trail.
 */

export const UNANSWERED_ROUTE = 'posthog:message_unanswered';
export const DEFAULT_UNANSWERED_AFTER_MINUTES = 15;
const LOOKBACK_HOURS = 24;
const TEXT_CHANNELS = ['sms', 'imessage'] as const;
const CLAIM_EPOCH = new Date(0);

export function unansweredAfterMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.POSTHOG_UNANSWERED_AFTER_MINUTES;
  const minutes = raw ? Number(raw) : DEFAULT_UNANSWERED_AFTER_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_UNANSWERED_AFTER_MINUTES * 60_000;
  return minutes * 60_000;
}

export interface UnansweredSweepResult {
  scanned: number;
  emitted: number;
  skipped: 'flag_off' | null;
}

function excludedFamilySet(): Set<string> {
  return new Set(
    (process.env.METRICS_EXCLUDED_FAMILY_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Inbound text turns recorded inside (since, until): the rows the router owns. */
function inboundTextTurns(since: Date, until: Date): SQL[] {
  const m = schema.channelMessages;
  return [
    eq(m.direction, 'in'),
    eq(m.category, 'reply'),
    inArray(m.channel, [...TEXT_CHANNELS]),
    gt(m.createdAt, since),
    lt(m.createdAt, until),
  ];
}

export async function sweepUnansweredMessages(
  database: Database,
  now: Date = new Date(),
): Promise<UnansweredSweepResult> {
  if (!errorTrackingEnabled()) return { scanned: 0, emitted: 0, skipped: 'flag_off' };

  const gapMs = unansweredAfterMs();
  const cutoff = new Date(now.getTime() - gapMs);
  const lookback = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60_000);
  const m = schema.channelMessages;
  const a = schema.auditLog;
  const r = schema.rateLimits;
  const excluded = excludedFamilySet();

  const candidates = await database
    .select({
      id: m.id,
      familyId: m.familyId,
      channel: m.channel,
      inGroup: m.inGroup,
      chatId: m.providerChatId,
      createdAt: m.createdAt,
    })
    .from(m)
    .where(
      and(
        ...inboundTextTurns(lookback, cutoff),
        notExists(
          database
            .select({ id: a.id })
            .from(a)
            .where(
              and(
                eq(a.actionTaken, TURN_ANSWERED_ACTION),
                eq(a.targetTable, TURN_LEDGER_TARGET),
                sql`${a.targetId} = ${m.id}::text`,
              ),
            ),
        ),
        notExists(
          database
            .select({ id: r.id })
            .from(r)
            .where(and(eq(r.route, UNANSWERED_ROUTE), sql`${r.identifier} = ${m.id}::text`)),
        ),
      ),
    );

  let emitted = 0;
  for (const row of candidates) {
    if (excluded.has(row.familyId)) continue;
    const [claimed] = await database
      .insert(schema.rateLimits)
      .values({
        identifier: row.id,
        route: UNANSWERED_ROUTE,
        windowStart: CLAIM_EPOCH,
        count: 1,
      })
      .onConflictDoNothing()
      .returning({ id: schema.rateLimits.id });
    if (!claimed) continue;
    const latencyMs = Math.max(0, now.getTime() - row.createdAt.getTime());
    await captureErrorEventAsync({
      event: 'message_unanswered',
      familyId: row.familyId,
      chatId: row.chatId,
      properties: {
        channel: row.inGroup === true ? 'group' : row.channel === 'imessage' ? 'imessage' : 'sms',
        is_group: row.inGroup === true,
        reply_ms: latencyMs,
      },
    });
    emitted += 1;
  }

  return { scanned: candidates.length, emitted, skipped: null };
}

/**
 * VIL-602 · a real parent's text the router never finished with pages #ops.
 *
 * On 2026-11-12 every 1:1 text went unanswered for four hours and nothing paged. Each one
 * held an answer claim, taken by its own burst folding it into itself, and no answer. So
 * "finished with" is read from what the router writes, and a claim alone is not enough:
 *   - an `sms_turn_answered`, `sms_turn_unanswered` (a reason it chose to stay silent) or
 *     `sms_turn_failed` row (that one pages through its own route) finishes a text;
 *   - so does its answer claim, which the router takes at its one exit and the door takes
 *     for a text it answers itself, unless the claim is a fold of the text into itself;
 *   - a text folded into another text is that text's turn to finish, and pages through it;
 *   - `sms_turn_deferred` finishes nothing: the parent is still waiting.
 *
 * A text counts once it is {@link OPS_DAILY_GAP_AFTER_MS} old, for one window after that,
 * so a page stops within the hour after an outage ends. Counted only: rows the router owns
 * (category `reply`, a chat Linq named as 1:1 or group: the router refuses an unnamed
 * chat with a recorded reason, and the shared-group door answers its own rows), from real
 * families (`resolveOpsExclusions`: never the canary, a probe, QA or the founder). One page
 * per hour (`pageOps`), carrying how many. Ids never leave this function.
 */
export const UNANSWERED_PAGE_WINDOW_MS = 60 * 60_000;

export interface UnansweredPageResult {
  unanswered: number;
  page: OpsPagerOutcome | 'nothing_to_page';
}

export async function pageUnansweredParentTexts(
  database: Database,
  pager: OpsPager,
  now: Date = new Date(),
): Promise<UnansweredPageResult> {
  const m = schema.channelMessages;
  const a = schema.auditLog;
  const c = schema.channelTurnAnswerClaims;
  const cutoff = new Date(now.getTime() - OPS_DAILY_GAP_AFTER_MS);
  const since = new Date(cutoff.getTime() - UNANSWERED_PAGE_WINDOW_MS);
  const ledgerSince = new Date(now.getTime() - TURN_LEDGER_LOOKBACK_MS);
  const ledgerRow = (actions: string[], also?: SQL) =>
    database
      .select({ one: sql`1` })
      .from(a)
      .where(
        and(
          // family_id + occurred_at lead audit_log's only index.
          eq(a.familyId, m.familyId),
          gte(a.occurredAt, ledgerSince),
          eq(a.targetTable, TURN_LEDGER_TARGET),
          sql`${a.targetId} = ${m.id}::text`,
          inArray(a.actionTaken, actions),
          also,
        ),
      );

  const rows = await database
    .select({ familyId: m.familyId })
    .from(m)
    .where(
      and(
        ...inboundTextTurns(since, cutoff),
        isNotNull(m.inGroup),
        notExists(
          ledgerRow([TURN_ANSWERED_ACTION, TURN_UNANSWERED_AUDIT_ACTION, TURN_FAILED_ACTION]),
        ),
        or(
          notExists(database.select({ one: sql`1` }).from(c).where(eq(c.channelMessageId, m.id))),
          exists(ledgerRow([TURN_FOLDED_ACTION], sql`${a.after} ->> 'into' = ${m.id}::text`)),
        ),
      ),
    );
  if (rows.length === 0) return { unanswered: 0, page: 'nothing_to_page' };

  const excluded = await resolveOpsExclusions(database, [
    ...new Set(rows.map((row) => row.familyId)),
  ]);
  const unanswered = rows.filter((row) => !excluded.has(row.familyId)).length;
  if (unanswered === 0) return { unanswered: 0, page: 'nothing_to_page' };
  const page = await pager.page({ site: 'parent_text_unanswered', facts: {}, count: unanswered });
  return { unanswered, page };
}

import { type Database, schema } from '@hale/db';
import { and, eq, gt, inArray, lt, notExists, sql } from 'drizzle-orm';
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
const TURN_ANSWERED = 'sms_turn_answered';
const TURN_LEDGER_TARGET = 'channel_messages';
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
        eq(m.direction, 'in'),
        eq(m.category, 'reply'),
        inArray(m.channel, [...TEXT_CHANNELS]),
        gt(m.createdAt, lookback),
        lt(m.createdAt, cutoff),
        notExists(
          database
            .select({ id: a.id })
            .from(a)
            .where(
              and(
                eq(a.actionTaken, TURN_ANSWERED),
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

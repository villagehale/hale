import { NextResponse } from 'next/server';
import { sweepUnansweredMessages } from '~/lib/analytics/unanswered';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

// Node runtime: reads channel_messages and rate_limits through the postgres driver.
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/cron/unanswered — PostHog `message_unanswered` for inbound texts with
 * no `sms_turn_answered` after N minutes (POSTHOG_UNANSWERED_AFTER_MINUTES, default
 * 15). Every five minutes. Dark until POSTHOG_ERROR_TRACKING_ENABLED=true.
 * Cron-secret gated like every cron route. Texts nobody.
 */
export const GET = cronRoute('unanswered', async () => {
  const result = await sweepUnansweredMessages(db());
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});

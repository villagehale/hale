import { NextResponse } from 'next/server';
import { pageUnansweredParentTexts, sweepUnansweredMessages } from '~/lib/analytics/unanswered';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';

// Node runtime: reads channel_messages and rate_limits through the postgres driver.
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/cron/unanswered — every five minutes. First, #ops is paged when a real
 * parent's text has gone fifteen minutes with nothing from the router (once an hour,
 * with the count; never flagged off). Then PostHog `message_unanswered` for inbound
 * texts with no `sms_turn_answered` after N minutes (POSTHOG_UNANSWERED_AFTER_MINUTES,
 * default 15), dark until POSTHOG_ERROR_TRACKING_ENABLED=true. Cron-secret gated like
 * every cron route. Texts nobody.
 */
export const GET = cronRoute('unanswered', async () => {
  const database = db();
  const page = await pageUnansweredParentTexts(database, failurePageOpsPager(db));
  const result = await sweepUnansweredMessages(database);
  return NextResponse.json({ ok: true, ...result, page }, { status: 200 });
});

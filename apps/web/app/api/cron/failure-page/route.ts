import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { pageFailureAlerts } from '~/lib/monitoring/failure-page';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

// Node runtime: reads audit_log and rate_limits through the postgres driver.
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/cron/failure-page — Slack #ops for failed text turns, failed
 * first hellos, provider billing/auth incidents, dead-lettered inbounds, and
 * a pile of deferred turns (VIL-404). Every five minutes, which is the bound
 * on a failure the inline hook did not already post. Cron-secret gated like
 * every cron route.
 *
 * The inline hook pages in the same request that recorded the failure. This
 * sweep is the backstop: a crash between the ledger write and Slack, or a
 * webhook that refused, leaves the claim unalerted and the next tick posts it.
 * One failure posts once (failure-page.ts).
 */
export const GET = cronRoute('failure-page', async () => {
  const result = await pageFailureAlerts(db(), {
    post: (text) => postOpsSlack(text),
  });
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});

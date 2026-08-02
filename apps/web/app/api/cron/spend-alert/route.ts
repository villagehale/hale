import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { checkRunFailureSpike } from '~/lib/monitoring/run-failure-spike';
import { checkMonthlySpend } from '~/lib/monitoring/spend';

// Node runtime: reads agent_runs via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/spend-alert — the hourly agent_runs watch. Two checks, one table, one
 * cadence:
 *
 *  - SPEND: sums this month's cost_usd and alerts when it crosses
 *    ANTHROPIC_SPEND_ALERT_USD, so a runaway agent loop is caught early rather than on
 *    the bill.
 *  - FAILURES (VIL-255): the backstop the pre-flight cannot be — if most of the runs
 *    that finished in the hour just closed FAILED, the founder is paged. A bad deploy
 *    or a broken tool answers a health probe perfectly well and still fails every
 *    family, and this hourly sweep covers every LLM cron in the schedule from one
 *    place rather than a post-flight duplicated into each of them.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const database = db();
  const spend = await checkMonthlySpend(database);
  const runs = await checkRunFailureSpike(database);
  return NextResponse.json({ ok: true, ...spend, runs }, { status: 200 });
}

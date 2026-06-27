import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { checkMonthlySpend } from '~/lib/monitoring/spend';

// Node runtime: reads agent_runs via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/spend-alert — sums this month's agent_runs.cost_usd and raises an
 * alert (console.error, surfaced in the platform logs) when it crosses
 * ANTHROPIC_SPEND_ALERT_USD, so a runaway agent loop is caught early rather than
 * on the bill.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const summary = await checkMonthlySpend(db());
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}

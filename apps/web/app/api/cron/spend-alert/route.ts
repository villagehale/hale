import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { checkAnthropicCredit } from '~/lib/monitoring/anthropic-credit';
import { defaultProviderHealthDeps } from '~/lib/monitoring/provider-health';
import { checkRunFailureSpike } from '~/lib/monitoring/run-failure-spike';
import { checkMonthlySpend } from '~/lib/monitoring/spend';

// Node runtime: reads agent_runs via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/spend-alert — the hourly agent_runs watch. Three checks, one
 * cadence:
 *
 *  - SPEND: sums this month's cost_usd and pages #ops once when it reaches
 *    ANTHROPIC_SPEND_ALERT_USD (unset → `threshold_not_configured`, no page), so a runaway agent loop is caught early rather than on
 *    the bill.
 *  - FAILURES (VIL-255): the backstop the pre-flight cannot be — if most of the runs
 *    that finished in the hour just closed FAILED, the founder is paged. A bad deploy
 *    or a broken tool answers a health probe perfectly well and still fails every
 *    family, and this hourly sweep covers every LLM cron in the schedule from one
 *    place rather than a post-flight duplicated into each of them.
 *  - PREPAID CREDIT: remaining = ANTHROPIC_CREDIT_START_USD minus anthropic_spend
 *    since ANTHROPIC_CREDIT_START_AT. Pages #ops once below ANTHROPIC_CREDIT_ALERT_USD
 *    (default 40) and once below 15, and once per expiry warning day (default 7 then 3)
 *    when ANTHROPIC_CREDIT_EXPIRES_AT is set. Dark unless ANTHROPIC_CREDIT_ALERT_ENABLED is
 *    exactly `true`. Slack #ops only — never a parent text.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export const GET = cronRoute('spend-alert', async () => {
  const database = db();
  const spend = await checkMonthlySpend(database, defaultProviderHealthDeps());
  const runs = await checkRunFailureSpike(database);
  const anthropicCredit = await checkAnthropicCredit(database);
  return NextResponse.json({ ok: true, ...spend, runs, anthropicCredit }, { status: 200 });
});

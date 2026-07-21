import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runSundaySendCron } from '~/lib/loop/send';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the send path reaches pg-boss + the Anthropic-adjacent channel seam,
// neither of which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/sunday-send — the Sunday text (VIL-218 · B2), triggered HOURLY by
 * Vercel Cron. Each hour it enqueues the weekly_plan message for every enrolled
 * parent whose OWN local weekly_plan_send_time is now (default Sunday 19:30),
 * reading B1's persisted artifact; the A2 drain dispatches it (mirror legs, dedupe,
 * ledger, audit).
 *
 * Cron auth is the spend gate: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and NOTHING runs. The SEND itself is additionally gated by
 * LOOP_SEND_ENABLED (default off) — compose-not-send until the founder flips it.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runSundaySendCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
}

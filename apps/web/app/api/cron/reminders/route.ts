import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runReminderCron } from '~/lib/loop/reminders/run';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the send path reaches pg-boss + the channel seam, neither of which
// runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/reminders — the D1 reminder scheduler (VIL-223), triggered HOURLY by
 * Vercel Cron. Each hour it converges the event_reminders ledger from live placed
 * events, then fires the due reminders that survive a fresh classify against the live
 * event (a cancelled/moved/started event never fires). Firing reminders enqueue onto
 * the A2 channel.send queue, which dispatches them (mirror legs, dedupe, ledger, audit).
 *
 * Cron auth is the spend gate: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and NOTHING runs. The SEND itself is additionally gated by LOOP_SEND_ENABLED
 * (default off) — compose-not-send until the founder flips it.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runReminderCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
}

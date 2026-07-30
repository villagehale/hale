import { NextResponse } from 'next/server';
import { runNudgeCron } from '~/lib/channel/nudge/run';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reaches the voice client and the channel seam, neither of
// which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/nudge — the F14 proactive nudge sweep (VIL-239 · M4), triggered HOURLY
 * by Vercel Cron. Its own route rather than a leg of /api/cron/reminders: the reminders
 * cron converges a ledger of things a parent already asked for, while this one decides
 * whether to interrupt a parent at all. Sharing a route would mean one failure budget,
 * one timeout, and one set of logs for two very different risks.
 *
 * It only ever acts on a family in their local send hour, so most hours are a no-op.
 *
 * Two gates, both fail-closed. Cron auth is the spend gate: a request without
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and NOTHING runs. F14_ENABLED /
 * F14_FAMILY_ALLOWLIST is the D21 dark-launch gate: unarmed, the sweep does not even
 * select families.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runNudgeCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
}

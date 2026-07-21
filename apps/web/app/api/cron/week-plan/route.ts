import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runWeekPlanCron } from '~/lib/loop/cron';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the composer reads its skill file off disk and calls the Anthropic
// SDK (the optional summary stage) — neither works on the edge runtime.
export const runtime = 'nodejs';
// A batch of families each run a bounded compose + one short agent call; allow the
// full Fluid Compute window so one invocation completes the batch.
export const maxDuration = 300;

/**
 * GET /api/cron/week-plan — the weekly-plan composer (VIL-217), triggered HOURLY by
 * Vercel Cron. Each hour it composes the upcoming-week plan for every family whose
 * OWN local send window (default Saturday 19:30) is now — the honest per-family-local
 * sweep, not the digest cron's fixed-UTC + Toronto cheat.
 *
 * Cron auth is the spend gate: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and the engine does NOTHING — no DB read, no compose, no model call, no
 * spend. The compose is idempotent per (family, week) and each family is bounded (the
 * per-run family cap + the summary stage's maxSteps × maxTokens ceiling).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runWeekPlanCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
}

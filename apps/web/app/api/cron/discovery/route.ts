import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { requireCronSecret } from '~/lib/cron/auth';
import { runDiscoveryCron } from '~/lib/cron/discovery';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: discovery reads the worker's prompt/model files off disk and
// calls the Anthropic SDK — neither works on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/discovery — the weekly village-discovery run, triggered by Vercel
 * Cron.
 *
 * Cron auth is the spend gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the engine does NOTHING — no
 * DB read, no model call, no spend. Only a legitimate cron call discovers. The
 * run is bounded to families with stale/empty candidates, capped per run; each
 * family is one bounded Anthropic call, family-scoped, teen-excluded at the
 * source (rule #1), and self-audited in the same transaction as its writes
 * (rule #6).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runDiscoveryCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    // Serverless flush: send buffered spans before the function returns (rule #8).
    await flushTelemetry();
  }
}

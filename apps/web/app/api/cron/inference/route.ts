import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { requireCronSecret } from '~/lib/cron/auth';
import { runInferenceCron } from '~/lib/cron/inference';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the agent reads its skill file off disk and calls the Anthropic
// SDK — neither works on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/inference — the nightly memory-inference run, triggered by Vercel
 * Cron.
 *
 * Cron auth is the spend gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the engine does NOTHING — no
 * DB read, no model call, no spend. Only a legitimate cron call infers. The run
 * is bounded (per-run family cap + the harness's maxSteps × maxTokens token
 * ceiling); every save_memory write is guarded (audited — rule #6) and held to
 * the 0.7 confidence floor; reads/writes are family-scoped (rule #1).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runInferenceCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    // Serverless flush: send buffered spans before the function returns (rule #8).
    await flushTelemetry();
  }
}

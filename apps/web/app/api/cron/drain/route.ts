import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { runDrainCron } from '~/lib/cron/drain';
import { captureException } from '~/lib/monitoring/sentry';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the drain instantiates pg-boss (prepared statements, raw pg) and
// runs the worker orchestrator (Anthropic SDK + disk-read prompts) — neither
// works on the edge runtime. maxDuration 800 gives the in-loop ~700s wall-clock
// budget headroom (recipe #1).
export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * GET /api/cron/drain — drains the two hot worker queues (events.ingested,
 * actions.approved) through the SAME orchestrator pipeline, on every-minute
 * Vercel Cron. The Fly worker is not deployed, so this serverless drain is what
 * actually consumes those jobs; the after()-kick on the enqueue paths handles
 * the common case immediately and this cron is the safety-net reaper.
 *
 * Cron auth is the gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the drain does NOTHING —
 * no pg-boss connection, no orchestrator run, no spend. Only a legitimate cron
 * call (or the internal after() kick, which carries the same secret) drains.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runDrainCron();
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of letting it 500 silently: report to Sentry
    // (no-op without a DSN) and log, then re-throw so the run is still a real
    // error, not a masked success (rule #8).
    captureException(err);
    console.error({ err }, 'cron/drain failed');
    throw err;
  } finally {
    // Serverless flush: send buffered agent spans before the function returns.
    await flushTelemetry();
  }
}

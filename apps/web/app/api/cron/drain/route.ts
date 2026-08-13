import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { DRAINABLE_QUEUES, runDrainCron } from '~/lib/cron/drain';
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
 *
 * `?queues=a,b` restricts the run to a slice of the drain plan. The inbound kick uses it
 * so a parent's text is picked up on its own rather than behind the outbound and LLM
 * queues that share the tick; the cron passes nothing and drains everything. Concurrent
 * runs are safe — pg-boss hands each job to exactly one fetcher.
 *
 * An unrecognised queue name is a 400 rather than a run that drains nothing and reports
 * success: a typo in a caller's slice would otherwise look exactly like an empty queue.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const requested = new URL(req.url).searchParams.get('queues');
  const queues = requested ? requested.split(',') : undefined;
  const unknown = queues?.filter((queue) => !DRAINABLE_QUEUES.includes(queue));
  if (unknown?.length) {
    return NextResponse.json({ error: 'unknown_queues', unknown }, { status: 400 });
  }

  try {
    const summary = await runDrainCron({ queues });
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of letting it 500 silently: log to the
    // platform, then re-throw so the run is still a real error, not a masked
    // success (rule #8).
    console.error({ err }, 'cron/drain failed');
    throw err;
  } finally {
    // Serverless flush: send buffered agent spans before the function returns.
    await flushTelemetry();
  }
}

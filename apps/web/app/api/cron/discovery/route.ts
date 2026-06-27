import { NextResponse, after } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { runDiscoveryCron } from '~/lib/cron/discovery';
import { kickDrain } from '~/lib/cron/kick-drain';
import { db } from '~/lib/db';
import { getQueue } from '~/lib/queue';
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
    const queue = await getQueue();
    const summary = await runDiscoveryCron(db(), undefined, new Date(), queue);
    // Kick the drain so any rerank jobs enqueued for newly-discovered families
    // materialize now rather than waiting up to 60s for the next cron tick.
    const origin = process.env.APP_URL ?? new URL(req.url).origin;
    after(() => kickDrain(origin));
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/discovery failed');
    throw err;
  } finally {
    // Serverless flush: send buffered spans before the function returns (rule #8).
    await flushTelemetry();
  }
}

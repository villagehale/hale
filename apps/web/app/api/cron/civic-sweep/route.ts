import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { runCivicSweepCron } from '~/lib/cron/civic-sweep';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reads the parse-civic-hours skill off disk and may call
// the Anthropic SDK for irregular schedule text — neither works on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/civic-sweep — the weekly free-civic-programming refresh
 * (VIL-252 · M16), triggered by Vercel Cron.
 *
 * Cron auth is the spend gate: without the matching `Authorization: Bearer
 * <CRON_SECRET>` the request gets 401 and nothing runs — no fetch, no model call,
 * no writes.
 *
 * Weekly rather than daily because that is how often these calendars actually
 * move: libraries publish a season at a time and EarlyON centres publish standing
 * hours. Sweeping harder would spend more to learn the same thing, and every
 * source here is a public body whose feed we are a guest on.
 */
export const GET = cronRoute('civic-sweep', async () => {
  try {
    const summary = await runCivicSweepCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log, then re-throw so the
    // run stays a real error rather than a masked success (rule #8).
    console.error({ err }, 'cron/civic-sweep failed');
    throw err;
  } finally {
    await flushTelemetry();
  }
});

import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runSocialWatchCron } from '~/lib/social/poll';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: Business Discovery is a fetch, and a configured model call reads
// the extract-social-spot skill off disk. Neither belongs on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/social-watch — hourly Instagram Business Discovery pass
 * (VIL-378). Minute 18, so it does not share a fixed minute with another cron.
 *
 * Dark unless SOCIAL_WATCHLIST=on. Missing Meta tokens return a named stub
 * and still tick signup-open watches. No parent-facing copy is produced.
 */
export const GET = cronRoute('social-watch', async () => {
  try {
    const summary = await runSocialWatchCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    console.error({ err }, 'cron/social-watch failed');
    throw err;
  } finally {
    await flushTelemetry();
  }
});

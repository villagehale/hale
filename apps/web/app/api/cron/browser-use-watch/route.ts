import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { browserUseWatchEnabled } from '~/lib/signup/browser-use/watch/flag';
import { browserUseWatchDepsFromEnv } from '~/lib/signup/browser-use/watch/runner';
import { runBrowserUseWatchSweep } from '~/lib/signup/browser-use/watch/sweep';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/browser-use-watch — hourly. Re-reads due provider pages with each
 * provider's saved Browser Use script. Off unless BROWSER_USE_WATCH_ENABLED is exactly
 * `true`; with the flag off it runs nothing and makes no Browser Use call (cronRoute
 * still stamps its heartbeat). Spend caps live in lib/signup/browser-use/watch/sweep.ts.
 */
export const GET = cronRoute('browser-use-watch', async () => {
  if (!browserUseWatchEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'flag_off' }, { status: 200 });
  }
  const result = await runBrowserUseWatchSweep(db(), browserUseWatchDepsFromEnv(), true);
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});

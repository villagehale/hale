import { NextResponse } from 'next/server';
import { runInboundCanary } from '~/lib/channel/canary/run';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';

// Node runtime: reads through the postgres driver and posts to our own webhook.
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/cron/inbound-canary — one synthetic inbound turn, every ten minutes.
 *
 * Every watchdog Hale has runs on the substrate it watches, and the one that
 * mattered stamped its heartbeat on COMPLETION: a drain whose every inbound job
 * threw looked exactly like a clean run, so nothing paged for six hours
 * (#617/#622). The read-side lane (deadman.ts) closes that hole for real
 * traffic; this closes it when there is none, by posting a Linq-signed inbound
 * to the real door and verifying the PREVIOUS tick's far-side artifact.
 *
 * Nothing is caught here on purpose. A failed tick pages #ops itself, once an
 * hour (run.ts), then throws: `cronRoute` stamps only when the handler returns,
 * so the cron also becomes its own stale alarm at 2×600+900 = 2100s.
 */
export const GET = cronRoute('inbound-canary', async () => {
  await runInboundCanary({
    database: db(),
    fetch,
    now: () => new Date(),
    pager: failurePageOpsPager(db),
  });
  return NextResponse.json({ ok: true }, { status: 200 });
});

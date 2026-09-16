import { NextResponse } from 'next/server';
import { runInboundCanary } from '~/lib/channel/canary/run';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

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
 * traffic; this closes it when there is none, by posting a Twilio-signed inbound
 * to the real door and verifying the PREVIOUS tick's far-side artifact.
 *
 * Nothing is caught here on purpose. `cronRoute` stamps only when the handler
 * returns, so every diagnosis runInboundCanary throws withholds the stamp and
 * this cron becomes its own stale alarm at 2×600+900 = 2100s — one failed tick
 * never pages, three consecutive do.
 */
export const GET = cronRoute('inbound-canary', async () => {
  await runInboundCanary({ database: db(), fetch, now: () => new Date() });
  return NextResponse.json({ ok: true }, { status: 200 });
});

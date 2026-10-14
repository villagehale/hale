import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runOpsDaily } from '~/lib/monitoring/ops-daily';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

// Node runtime: reads the ledgers through the postgres driver and decrypts channels
// to tell probe households from real ones.
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/ops-daily — the daily #ops post over every real family (VIL-409).
 * Once a day at 13:14 UTC over the 24h ending on the hour. Monitoring only: it
 * texts nobody and gates no send. A manual GET with the cron secret re-posts a day
 * whose post did not land; a day already posted answers `already_posted`.
 */
export const GET = cronRoute('ops-daily', async () => {
  const outcome = await runOpsDaily(db(), { post: (text) => postOpsSlack(text) });
  return NextResponse.json({ ok: true, outcome }, { status: 200 });
});

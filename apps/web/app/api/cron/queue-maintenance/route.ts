import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { runQueueMaintenanceCron } from '~/lib/cron/queue-maintenance';

// Node runtime: instantiates pg-boss (prepared statements, raw pg) — not edge.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/queue-maintenance — runs pg-boss maintenance (expire stuck
 * `active` jobs, archive completed) on a schedule, since the supervising Fly
 * worker is not deployed (recipe #2). Cron-secret gated like every cron route.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    await runQueueMaintenanceCron();
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/queue-maintenance failed');
    throw err;
  }
}

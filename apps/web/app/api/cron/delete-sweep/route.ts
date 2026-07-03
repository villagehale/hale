import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runDeletionSweep } from '~/lib/rights/delete';

// Node runtime: the sweep deletes via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/delete-sweep — the closing leg of the reversible-by-grace account
 * deletion (PIPEDA/Law 25 erasure). Hard-deletes every family whose grace window
 * has elapsed; the families FK cascade erases that family's data in one DELETE.
 * Until the grace lapses the stamp can be cleared to cancel, so this sweep only
 * ever erases families that have been scheduled AND waited out the window.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING — no DB read,
 * no delete. The erased count is logged so the erasure is recorded durably,
 * outside the rows the cascade removes (rule #6 note in runDeletionSweep).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const summary = await runDeletionSweep(db());
  if (summary.erased > 0) {
    console.info({ erased: summary.erased }, 'cron/delete-sweep: erased families past grace');
  }
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}

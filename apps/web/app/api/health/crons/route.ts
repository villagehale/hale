import { schema } from '@hale/db';
import { NextResponse } from 'next/server';
import { assessCronHealth } from '~/lib/cron/deadman';
import { armCronHeartbeats } from '~/lib/cron/heartbeat';
import { db } from '~/lib/db';
import vercelConfig from '~/vercel.json';

// Node runtime: reads cron_heartbeats via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/health/crons — the dead-man switch's public face (audit P1-8).
 *
 * Compares every cron declared in vercel.json (imported, not copied — the file
 * the platform reads is the manifest of record) against its cron_heartbeats
 * stamp and answers ok/stale per cron. The off-Vercel checker
 * (.github/workflows/cron-deadman.yml) polls this from GitHub Actions — a
 * failure domain that shares nothing with the Vercel cron substrate the
 * watchdog layer itself runs on.
 *
 * Unauthenticated BUT unrevealing (rule #1): the body carries cron slugs,
 * ages, and thresholds — liveness metadata only. No error text, no counts, no
 * queue depths, no family data, and nothing here accepts input.
 *
 * A cron the ledger has never seen is ARMED — a baseline row is inserted at
 * now() (idempotent, ON CONFLICT DO NOTHING, bounded by the manifest) so its
 * clock starts at first sight instead of paging falsely until its first slot;
 * if it truly never runs it reads stale one threshold later.
 *
 * A DB that cannot be read answers 503 rather than a hollow "ok": to the
 * checker, an unreachable verdict pages exactly like a stale cron — a refusal
 * is not evidence of health.
 */
export async function GET() {
  let rows: (typeof schema.cronHeartbeats.$inferSelect)[];
  try {
    rows = await db().select().from(schema.cronHeartbeats);
  } catch (err) {
    console.error('health/crons: heartbeat ledger unreadable', { err });
    return NextResponse.json(
      { ok: false, error: 'db_unreachable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const report = assessCronHealth(vercelConfig.crons, rows, new Date());

  const armed = report.crons.filter((cron) => cron.status === 'armed').map((cron) => cron.name);
  if (armed.length > 0) {
    try {
      await armCronHeartbeats(db(), armed);
    } catch (err) {
      // Named, logged, and self-healing: the next probe arms again (rule #11).
      console.error('health/crons: arming failed', { armed, err });
    }
  }

  return NextResponse.json(
    { ok: report.ok, generatedAt: new Date().toISOString(), crons: report.crons },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
